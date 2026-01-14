/**
 * Figma Relay Agent
 *
 * Bridges AWS MCP WebSocket API to local Figma plugin.
 * - Connects outbound to AWS WebSocket API Gateway
 * - Runs local WebSocket server on port 3055 for Figma plugin
 * - Routes messages between AWS and plugin
 * - Supports API key auth (preferred) or Cognito JWT auth
 */

import WebSocket, { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const AWS_WS_URL = process.env.AWS_WS_URL || '';
const PLUGIN_PORT = parseInt(process.env.PLUGIN_PORT || '3055', 10);
const RECONNECT_DELAY = 5000; // 5 seconds
const TOKEN_REFRESH_INTERVAL = 23 * 60 * 60 * 1000; // 23 hours (tokens last 24h)

// API Key authentication (preferred - no refresh needed)
const API_KEY = process.env.API_KEY || '';

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

// ============================================================================
// Local WebSocket Server for Figma Plugin (port 3055)
// ============================================================================

const pluginServer = new WebSocketServer({ port: PLUGIN_PORT });
console.log(`[Relay] Plugin server started on port ${PLUGIN_PORT}`);

pluginServer.on('connection', (ws) => {
  console.log('[Relay] Figma plugin connected');
  pluginConnection = ws;

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
}): Promise<void> {
  const { relayRequestId, tool, args, httpRequest } = message;

  try {
    // Map tool name to plugin message type
    const pluginMessage = mapToolToPluginMessage(tool, args);

    // Send to plugin and wait for response
    const result = await sendToPlugin(pluginMessage);

    // Send response back to AWS
    if (awsConnection?.readyState === WebSocket.OPEN) {
      awsConnection.send(JSON.stringify({
        type: 'FIGMA_RESPONSE',
        relayRequestId,
        success: true,
        result,
        httpRequest, // Echo back for HTTP response routing
      }));
    }
  } catch (error) {
    // Send error back to AWS
    if (awsConnection?.readyState === WebSocket.OPEN) {
      awsConnection.send(JSON.stringify({
        type: 'FIGMA_RESPONSE',
        relayRequestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        httpRequest, // Echo back for HTTP response routing
      }));
    }
  }
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

  // Only initialize tokens if not using API key
  if (!API_KEY) {
    await initializeTokens();
    // Schedule token refresh only for Cognito auth
    scheduleTokenRefresh();
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
