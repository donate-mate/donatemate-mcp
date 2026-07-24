/**
 * Figma Relay Agent
 *
 * Bridges AWS MCP WebSocket API to local Figma plugin.
 * - Connects outbound to AWS WebSocket API Gateway
 * - Runs local WebSocket server on port 3055 for Figma plugin
 * - Routes messages between AWS and plugin
 * - Supports API key auth (preferred) or Cognito JWT auth
 * - File management: open, list, and track Figma files
 */

import WebSocket, { WebSocketServer } from 'ws';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Large plugin responses (e.g. exported images) exceed the API Gateway WebSocket 128KB frame
// limit. When the request carries an S3 target, upload oversized responses to S3 (via the VM
// instance role) and return a small { __s3Key } pointer instead of the inline payload.
const s3 = new S3Client({});
const OFFLOAD_THRESHOLD_BYTES = 96 * 1024;

// Configuration
const AWS_WS_URL = process.env.AWS_WS_URL || '';
const PLUGIN_PORT = parseInt(process.env.PLUGIN_PORT || '3055', 10);
const RECONNECT_DELAY = 5000; // 5 seconds
const TOKEN_REFRESH_INTERVAL = 23 * 60 * 60 * 1000; // 23 hours (tokens last 24h)

// API Key authentication (preferred - no refresh needed)
const API_KEY = process.env.API_KEY || '';

// Figma REST API configuration
const FIGMA_ACCESS_TOKEN = process.env.FIGMA_ACCESS_TOKEN || '';
const FIGMA_TEAM_ID = process.env.FIGMA_TEAM_ID || '';

// Cognito configuration (fallback if no API key)
const COGNITO_CLIENT_ID = '6dbffkps8dv6j8q4sbsk74qrec';
const COGNITO_REGION = 'us-east-2';
const TOKEN_FILE = path.join(process.env.APPDATA || process.env.HOME || '.', 'figma-relay-tokens.json');

// Token state (only used if not using API key)
let currentAccessToken = process.env.AUTH_TOKEN || '';
let currentRefreshToken = '';
let tokenRefreshTimer: NodeJS.Timeout | null = null;

// State
let awsConnection: WebSocket | null = null;
let pluginConnection: WebSocket | null = null;
let pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
let requestId = 0;
let currentFileKey: string | null = null;
let currentFileName: string | null = null;

// File cache (refreshed periodically)
interface FigmaFile {
  key: string;
  name: string;
  thumbnail_url?: string;
  last_modified: string;
  project?: string;
  projectId?: string;
}
let fileCache: FigmaFile[] = [];
let fileCacheExpiry = 0;

// ============================================================================
// Local WebSocket Server for Figma Plugin (port 3055)
// ============================================================================

const pluginServer = new WebSocketServer({ port: PLUGIN_PORT });
console.log(`[Relay] Plugin server started on port ${PLUGIN_PORT}`);

pluginServer.on('connection', async (ws) => {
  console.log('[Relay] Figma plugin connected');
  pluginConnection = ws;

  // Get current file info from plugin
  setTimeout(async () => {
    try {
      const docInfo = await sendToPlugin({ type: 'GET_DOCUMENT_INFO' }) as any;
      if (docInfo?.data) {
        currentFileName = docInfo.data.name;
        if (docInfo.data.fileKey) {
          currentFileKey = docInfo.data.fileKey;
        }
        console.log(`[Relay] Current file: ${currentFileName}${currentFileKey ? ` (${currentFileKey})` : ''}`);
      }
    } catch (e) {
      console.log('[Relay] Could not get initial document info');
    }
  }, 1000);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[Relay] Received from plugin:', message.type || message.requestId);

      // If this is a response to a pending request, resolve it
      if (message.requestId && pendingRequests.has(message.requestId)) {
        const pending = pendingRequests.get(message.requestId)!;
        pendingRequests.delete(message.requestId);
        pending.resolve(message);
      }

      // Forward to AWS if it's a response to a relay request
      if (message.relayRequestId && awsConnection?.readyState === WebSocket.OPEN) {
        awsConnection.send(JSON.stringify({
          type: 'FIGMA_RESPONSE',
          relayRequestId: message.relayRequestId,
          result: message,
        }));
      }
    } catch (e) {
      console.error('[Relay] Error parsing plugin message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[Relay] Figma plugin disconnected');
    pluginConnection = null;
  });

  ws.on('error', (error) => {
    console.error('[Relay] Plugin socket error:', error);
  });
});

// ============================================================================
// Send to Figma Plugin
// ============================================================================

function sendToPlugin(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!pluginConnection || pluginConnection.readyState !== WebSocket.OPEN) {
      reject(new Error('Figma plugin not connected. Please open Figma and run the DonateMate Design Bridge plugin.'));
      return;
    }

    const id = `req_${++requestId}`;
    message.requestId = id;
    pendingRequests.set(id, { resolve, reject });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timed out'));
      }
    }, 30000);

    pluginConnection.send(JSON.stringify(message));
  });
}

// ============================================================================
// Token Management
// ============================================================================

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadTokens(): TokenData | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      return data;
    }
  } catch (e) {
    console.log('[Relay] No saved tokens found');
  }
  return null;
}

function saveTokens(accessToken: string, refreshToken: string): void {
  const data: TokenData = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    console.log('[Relay] Tokens saved');
  } catch (e) {
    console.error('[Relay] Failed to save tokens:', e);
  }
}

async function refreshAccessToken(): Promise<boolean> {
  if (!currentRefreshToken) {
    console.log('[Relay] No refresh token available');
    return false;
  }

  try {
    console.log('[Relay] Refreshing access token...');
    const cmd = `aws cognito-idp initiate-auth --auth-flow REFRESH_TOKEN_AUTH --client-id ${COGNITO_CLIENT_ID} --auth-parameters "REFRESH_TOKEN=${currentRefreshToken}" --region ${COGNITO_REGION} --query "AuthenticationResult.AccessToken" --output text`;
    const newToken = execSync(cmd, { encoding: 'utf-8' }).trim();

    if (newToken && !newToken.includes('error')) {
      currentAccessToken = newToken;
      saveTokens(currentAccessToken, currentRefreshToken);
      console.log('[Relay] Access token refreshed successfully');
      return true;
    }
  } catch (e) {
    console.error('[Relay] Failed to refresh token:', e);
  }
  return false;
}

function scheduleTokenRefresh(): void {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
  }

  tokenRefreshTimer = setTimeout(async () => {
    const success = await refreshAccessToken();
    if (success) {
      // Reconnect with new token
      if (awsConnection) {
        awsConnection.close();
      }
    }
    scheduleTokenRefresh();
  }, TOKEN_REFRESH_INTERVAL);

  console.log('[Relay] Token refresh scheduled in 23 hours');
}

async function initializeTokens(): Promise<void> {
  // Try to load saved tokens
  const saved = loadTokens();
  if (saved) {
    if (saved.expiresAt > Date.now()) {
      currentAccessToken = saved.accessToken;
      currentRefreshToken = saved.refreshToken;
      console.log('[Relay] Loaded saved tokens');
    } else if (saved.refreshToken) {
      currentRefreshToken = saved.refreshToken;
      await refreshAccessToken();
    }
  }

  // If we have a refresh token from env, save it
  if (process.env.REFRESH_TOKEN) {
    currentRefreshToken = process.env.REFRESH_TOKEN;
    saveTokens(currentAccessToken, currentRefreshToken);
  }
}

// ============================================================================
// AWS WebSocket Connection (outbound)
// ============================================================================

function connectToAws(): void {
  if (!AWS_WS_URL) {
    console.error('[Relay] AWS_WS_URL not configured');
    return;
  }

  // Prefer API key over Cognito token
  const token = API_KEY || currentAccessToken;
  const url = token
    ? `${AWS_WS_URL}?token=${token}`
    : AWS_WS_URL;

  console.log('[Relay] Connecting to AWS...', API_KEY ? '(using API key)' : '(using Cognito token)');
  awsConnection = new WebSocket(url);

  awsConnection.on('open', () => {
    console.log('[Relay] Connected to AWS');

    // Register as Figma relay
    awsConnection!.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'relay/register',
      params: { type: 'figma' },
    }));
  });

  awsConnection.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[Relay] Received from AWS:', message.type || message.method);

      // Handle Figma tool requests from AWS
      if (message.type === 'FIGMA_TOOL_CALL') {
        await handleFigmaToolCall(message);
      }
    } catch (e) {
      console.error('[Relay] Error processing AWS message:', e);
    }
  });

  awsConnection.on('close', () => {
    console.log('[Relay] Disconnected from AWS, reconnecting...');
    awsConnection = null;
    setTimeout(connectToAws, RECONNECT_DELAY);
  });

  awsConnection.on('error', (error) => {
    console.error('[Relay] AWS connection error:', error);
  });
}

// ============================================================================
// Handle Figma Tool Calls from AWS
// ============================================================================

async function handleFigmaToolCall(message: {
  relayRequestId: string;
  tool: string;
  args: Record<string, unknown>;
  httpRequest?: boolean; // Flag to indicate this came from HTTP transport
  s3Bucket?: string; // Where to offload an oversized response
  s3Key?: string;
}): Promise<void> {
  const { relayRequestId, tool, args, httpRequest, s3Bucket, s3Key } = message;

  const sendResponse = (success: boolean, result: unknown, error?: string) => {
    if (awsConnection?.readyState === WebSocket.OPEN) {
      awsConnection.send(JSON.stringify({
        type: 'FIGMA_RESPONSE',
        relayRequestId,
        success,
        result: success ? result : undefined,
        error: success ? undefined : error,
        httpRequest,
      }));
    }
  };

  try {
    const toolName = tool.replace(/^dm_figma_/, '').replace(/^figma_/, '');

    // Handle file management tools directly in relay (don't go to plugin)
    switch (toolName) {
      case 'open_file': {
        const { fileKey, fileName, waitForPlugin = true } = args as {
          fileKey?: string;
          fileName?: string;
          waitForPlugin?: boolean;
        };

        let targetKey = fileKey;

        // If fileName provided, find the file key
        if (!targetKey && fileName) {
          await getAllFiles(); // Ensure cache is populated
          const file = findFileByName(fileName);
          if (!file) {
            sendResponse(false, null, `File not found: ${fileName}`);
            return;
          }
          targetKey = file.key;
        }

        if (!targetKey) {
          sendResponse(false, null, 'Either fileKey or fileName is required');
          return;
        }

        const result = await openFigmaFile(targetKey, waitForPlugin);
        sendResponse(true, result);
        return;
      }

      case 'list_files': {
        const { refresh = false } = args as { refresh?: boolean };
        const files = await getAllFiles(refresh);
        sendResponse(true, {
          files: files.map(f => ({
            key: f.key,
            name: f.name,
            project: f.project,
            lastModified: f.last_modified,
          })),
          total: files.length,
          cached: !refresh && Date.now() < fileCacheExpiry,
        });
        return;
      }

      case 'find_file': {
        const { query } = args as { query: string };
        if (!query) {
          sendResponse(false, null, 'Query is required');
          return;
        }

        await getAllFiles(); // Ensure cache is populated
        const lowerQuery = query.toLowerCase();

        // Score and rank files
        const scored = fileCache.map(f => {
          const nameLower = f.name.toLowerCase();
          let score = 0;

          if (nameLower === lowerQuery) score = 100;
          else if (nameLower.startsWith(lowerQuery)) score = 80;
          else if (nameLower.includes(lowerQuery)) score = 60;
          else {
            // Check if all query words are present
            const queryWords = lowerQuery.split(/\s+/);
            const matchedWords = queryWords.filter(w => nameLower.includes(w));
            score = (matchedWords.length / queryWords.length) * 40;
          }

          return { ...f, score };
        }).filter(f => f.score > 0).sort((a, b) => b.score - a.score);

        sendResponse(true, {
          query,
          matches: scored.slice(0, 10).map(f => ({
            key: f.key,
            name: f.name,
            project: f.project,
            score: f.score,
          })),
        });
        return;
      }

      case 'current_file': {
        sendResponse(true, {
          fileKey: currentFileKey,
          fileName: currentFileName,
          pluginConnected: pluginConnection?.readyState === WebSocket.OPEN,
        });
        return;
      }

      default:
        // Fall through to plugin message handling
        break;
    }

    // Map tool name to plugin message type and send to plugin
    const pluginMessage = mapToolToPluginMessage(tool, args);
    const result = await sendToPlugin(pluginMessage);

    // Offload oversized responses to S3 so they don't blow the WebSocket 128KB frame limit.
    let outResult: unknown = result;
    try {
      const serialized = JSON.stringify(result);
      if (s3Bucket && s3Key && serialized.length > OFFLOAD_THRESHOLD_BYTES) {
        await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: s3Key, Body: serialized, ContentType: 'application/json' }));
        outResult = { __s3Key: s3Key, __offloaded: true, __bytes: serialized.length };
        console.log(`[Relay] offloaded ${serialized.length}B response for ${tool} to s3://${s3Bucket}/${s3Key}`);
      }
    } catch (offloadErr) {
      console.error('[Relay] S3 offload failed, sending inline:', offloadErr instanceof Error ? offloadErr.message : offloadErr);
    }
    sendResponse(true, outResult);

  } catch (error) {
    sendResponse(false, null, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// Figma REST API Functions
// ============================================================================

async function figmaApiRequest<T>(endpoint: string): Promise<T> {
  if (!FIGMA_ACCESS_TOKEN) {
    throw new Error('FIGMA_ACCESS_TOKEN not configured');
  }

  const response = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: {
      'X-Figma-Token': FIGMA_ACCESS_TOKEN,
    },
  });

  if (!response.ok) {
    throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function listTeamProjects(): Promise<Array<{ id: string; name: string }>> {
  if (!FIGMA_TEAM_ID) {
    throw new Error('FIGMA_TEAM_ID not configured');
  }

  const data = await figmaApiRequest<{ projects: Array<{ id: string; name: string }> }>(
    `/teams/${FIGMA_TEAM_ID}/projects`
  );
  return data.projects || [];
}

async function listProjectFiles(projectId: string): Promise<FigmaFile[]> {
  const data = await figmaApiRequest<{ files: FigmaFile[] }>(
    `/projects/${projectId}/files`
  );
  return data.files || [];
}

async function getAllFiles(forceRefresh = false): Promise<FigmaFile[]> {
  // Return cached if still valid
  if (!forceRefresh && fileCache.length > 0 && Date.now() < fileCacheExpiry) {
    return fileCache;
  }

  console.log('[Relay] Refreshing file cache...');
  const allFiles: FigmaFile[] = [];

  try {
    const projects = await listTeamProjects();

    for (const project of projects) {
      try {
        const files = await listProjectFiles(project.id);
        for (const file of files) {
          allFiles.push({
            ...file,
            project: project.name,
            projectId: project.id,
          });
        }
      } catch (e) {
        console.error(`[Relay] Error fetching files for project ${project.name}:`, e);
      }
    }

    fileCache = allFiles;
    fileCacheExpiry = Date.now() + 5 * 60 * 1000; // Cache for 5 minutes
    console.log(`[Relay] Cached ${allFiles.length} files from ${projects.length} projects`);
  } catch (e) {
    console.error('[Relay] Error refreshing file cache:', e);
    if (fileCache.length > 0) {
      return fileCache; // Return stale cache on error
    }
    throw e;
  }

  return allFiles;
}

function findFileByName(query: string): FigmaFile | null {
  const lowerQuery = query.toLowerCase();

  // Exact match first
  let match = fileCache.find(f => f.name.toLowerCase() === lowerQuery);
  if (match) return match;

  // Contains match
  match = fileCache.find(f => f.name.toLowerCase().includes(lowerQuery));
  if (match) return match;

  // Fuzzy match (all query words present)
  const queryWords = lowerQuery.split(/\s+/);
  match = fileCache.find(f => {
    const nameLower = f.name.toLowerCase();
    return queryWords.every(word => nameLower.includes(word));
  });

  return match || null;
}

// ============================================================================
// File Management Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openFigmaFile(fileKey: string, waitForPlugin = true): Promise<{ success: boolean; fileKey: string }> {
  console.log(`[Relay] Opening Figma file: ${fileKey}`);

  // Open via URL handler (works on Windows)
  const figmaUrl = `figma://file/${fileKey}`;

  return new Promise((resolve, reject) => {
    // Use start command on Windows
    exec(`start "" "${figmaUrl}"`, async (error) => {
      if (error) {
        console.error('[Relay] Failed to open Figma URL:', error);
        reject(new Error(`Failed to open Figma file: ${error.message}`));
        return;
      }

      console.log('[Relay] Figma URL opened, waiting for plugin...');

      if (!waitForPlugin) {
        resolve({ success: true, fileKey });
        return;
      }

      // Wait for plugin to connect/reconnect with the new file
      try {
        await waitForPluginReady(fileKey, 30000);
        currentFileKey = fileKey;
        resolve({ success: true, fileKey });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function waitForPluginReady(expectedFileKey: string | null, timeout = 30000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (pluginConnection?.readyState === WebSocket.OPEN) {
      try {
        // Ask plugin for current document info
        const docInfo = await sendToPlugin({ type: 'GET_DOCUMENT_INFO' }) as any;

        if (docInfo?.data) {
          currentFileName = docInfo.data.name;
          if (docInfo.data.fileKey) {
            currentFileKey = docInfo.data.fileKey;
          }

          // If we're looking for a specific file, check if we're there
          if (!expectedFileKey || docInfo.data.fileKey === expectedFileKey) {
            console.log(`[Relay] Plugin ready in file: ${currentFileName}`);
            return;
          }
        }
      } catch (e) {
        // Plugin might not be ready yet
      }
    }

    await sleep(500);
  }

  throw new Error(`Timeout waiting for plugin to be ready${expectedFileKey ? ` in file ${expectedFileKey}` : ''}`);
}

// ============================================================================
// Map MCP Tool Names to Plugin Message Types
// ============================================================================

function mapToolToPluginMessage(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  // Strip dm_figma_ prefix if present
  const toolName = tool.replace(/^dm_figma_/, '').replace(/^figma_/, '');

  // Map to plugin message format
  const typeMap: Record<string, string> = {
    get_document_info: 'GET_DOCUMENT_INFO',
    get_selection: 'GET_SELECTION',
    get_page: 'GET_PAGE',
    set_page: 'SET_PAGE',
    get_node: 'GET_NODE',
    get_node_plugin: 'GET_NODE', // Plugin-based node retrieval (maps to same handler)
    get_children: 'GET_CHILDREN', // Get children of a specific node
    get_all_nodes: 'GET_ALL_NODES',
    update_node: 'UPDATE_NODE',
    delete_node: 'DELETE_NODE',
    clone_node: 'CLONE_NODE',
    move_node: 'MOVE_NODE',
    group_nodes: 'GROUP_NODES',
    ungroup_nodes: 'UNGROUP_NODES',
    set_selection: 'SET_SELECTION',
    zoom_to_node: 'ZOOM_TO_NODE',
    create_frame: 'CREATE_FRAME',
    create_text: 'CREATE_TEXT',
    create_rectangle: 'CREATE_RECTANGLE',
    create_ellipse: 'CREATE_ELLIPSE',
    create_line: 'CREATE_LINE',
    create_auto_layout: 'CREATE_AUTO_LAYOUT',
    create_component: 'CREATE_COMPONENT',
    create_screen: 'CREATE_SCREEN',
    export_node: 'EXPORT_NODE',
    get_styles: 'GET_STYLES',
    get_local_styles: 'GET_STYLES', // Alias
    get_variables: 'GET_VARIABLES',
    apply_tokens: 'APPLY_TOKENS',
    get_file_context: 'GET_FILE_CONTEXT', // For branching workflow
    validate_design: 'VALIDATE_DESIGN', // Design validation hook
    // New tools
    execute: 'EXECUTE',
    query: 'QUERY',
    export_and_describe: 'EXPORT_AND_DESCRIBE',
    review: 'EXPORT_AND_DESCRIBE', // Alias
  };

  const messageType = typeMap[toolName] || toolName.toUpperCase();

  return {
    type: messageType,
    ...args,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('[Relay] Figma Relay Agent starting...');
  console.log(`[Relay] Plugin port: ${PLUGIN_PORT}`);
  console.log(`[Relay] AWS URL: ${AWS_WS_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`[Relay] Auth method: ${API_KEY ? 'API Key' : 'Cognito JWT'}`);
  console.log(`[Relay] Figma REST API: ${FIGMA_ACCESS_TOKEN ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`[Relay] Team ID: ${FIGMA_TEAM_ID || 'NOT CONFIGURED'}`);

  // Only initialize tokens if not using API key
  if (!API_KEY) {
    await initializeTokens();
    // Schedule token refresh only for Cognito auth
    scheduleTokenRefresh();
  }

  // Pre-populate file cache if Figma API is configured
  if (FIGMA_ACCESS_TOKEN && FIGMA_TEAM_ID) {
    getAllFiles().catch(e => console.error('[Relay] Initial file cache failed:', e));
  }

  // Connect to AWS (will auto-reconnect)
  connectToAws();
}

main().catch(console.error);

// Keep process alive
process.on('SIGINT', () => {
  console.log('[Relay] Shutting down...');
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  pluginServer.close();
  awsConnection?.close();
  process.exit(0);
});
