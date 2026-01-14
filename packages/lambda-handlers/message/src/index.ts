/**
 * MCP WebSocket $default Handler
 *
 * Processes MCP (Model Context Protocol) messages and routes them to appropriate tools.
 * This is the main entry point for all MCP operations.
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';

// Import token service from mcp-server package
// For bundling, we inline a simplified version here
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dynamoClient = new DynamoDBClient({});
const ssmClient = new SSMClient({});

// ============================================================================
// Figma Client
// ============================================================================

const FIGMA_API_BASE = 'https://api.figma.com/v1';

// Cache Figma token to avoid repeated SSM calls
let cachedFigmaToken: string | null = null;

async function getFigmaToken(): Promise<string> {
  if (cachedFigmaToken) return cachedFigmaToken;

  const paramName = process.env.FIGMA_TOKEN_PARAM_NAME;
  if (!paramName) {
    throw new Error('FIGMA_TOKEN_PARAM_NAME environment variable not set');
  }

  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  const token = result.Parameter?.Value;
  if (!token || token === 'FIGMA_TOKEN_NOT_CONFIGURED') {
    throw new Error(
      `Figma token not configured. Update the SSM parameter ${paramName} with your Figma Personal Access Token.`
    );
  }

  cachedFigmaToken = token;
  return token;
}

interface FigmaFile {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components: Record<string, FigmaComponent>;
  styles: Record<string, FigmaStyle>;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

interface FigmaComponent {
  key: string;
  name: string;
  description: string;
}

interface FigmaStyle {
  key: string;
  name: string;
  styleType: string;
  description: string;
}

interface FigmaComment {
  id: string;
  message: string;
  created_at: string;
  user: { handle: string; img_url: string };
}

async function figmaRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = await getFigmaToken();

  const url = `${FIGMA_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'X-Figma-Token': token,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Figma API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Figma URL Parser - Extract file key and node ID from Figma URLs
// ============================================================================

interface ParsedFigmaUrl {
  fileKey: string;
  nodeId?: string;
  fileName?: string;
}

function parseFigmaUrl(url: string): ParsedFigmaUrl {
  // Support formats:
  // https://www.figma.com/file/ABC123/File-Name
  // https://www.figma.com/file/ABC123/File-Name?node-id=123:456
  // https://www.figma.com/design/ABC123/File-Name?node-id=123-456
  // https://figma.com/file/ABC123

  const patterns = [
    /figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/([^?]+))?(?:\?.*node-id=([0-9:-]+))?/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        fileKey: match[1],
        fileName: match[2] ? decodeURIComponent(match[2].replace(/-/g, ' ')) : undefined,
        nodeId: match[3]?.replace('-', ':'),
      };
    }
  }

  throw new Error(`Invalid Figma URL: ${url}. Expected format: https://www.figma.com/file/FILE_KEY/...`);
}

// ============================================================================
// Figma Relay - for plugin-based tools
// ============================================================================

let relayRequestId = 0;

// Register a Figma relay connection
async function registerFigmaRelay(connectionId: string): Promise<void> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  if (!tableName) return;

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        connectionId: { S: 'figma-relay' }, // Special key for relay
        relayConnectionId: { S: connectionId },
        registeredAt: { S: new Date().toISOString() },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) }, // 24 hours
      },
    })
  );
  console.info('Figma relay registered', { connectionId });
}

// Get the current Figma relay connection ID
async function getFigmaRelayConnectionId(): Promise<string | null> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  if (!tableName) return null;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { connectionId: { S: 'figma-relay' } },
    })
  );

  return result.Item?.relayConnectionId?.S || null;
}

// Store pending relay request in DynamoDB
async function storePendingRelayRequest(
  requestId: string,
  clientConnectionId: string,
  jsonRpcId: number | string
): Promise<void> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  if (!tableName) return;

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        connectionId: { S: `relay-request:${requestId}` },
        clientConnectionId: { S: clientConnectionId },
        jsonRpcId: { S: String(jsonRpcId) },
        createdAt: { S: new Date().toISOString() },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 60) }, // 60 seconds
      },
    })
  );
}

// Get pending relay request from DynamoDB
async function getPendingRelayRequest(
  requestId: string
): Promise<{ clientConnectionId: string; jsonRpcId: string } | null> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  if (!tableName) return null;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { connectionId: { S: `relay-request:${requestId}` } },
    })
  );

  if (!result.Item) return null;

  // Delete the request after retrieving
  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { connectionId: { S: `relay-request:${requestId}` } },
    })
  );

  return {
    clientConnectionId: result.Item.clientConnectionId?.S || '',
    jsonRpcId: result.Item.jsonRpcId?.S || '0',
  };
}

// Send a tool call to the Figma relay (fire and forget - response comes via separate message)
async function sendToFigmaRelay(
  apiClient: ApiGatewayManagementApiClient,
  clientConnectionId: string,
  jsonRpcId: number | string,
  tool: string,
  args: Record<string, unknown>
): Promise<void> {
  const relayConnectionId = await getFigmaRelayConnectionId();
  if (!relayConnectionId) {
    throw new Error(
      'Figma relay not connected. Please start the Figma relay agent and ensure Figma Desktop is running with the plugin.'
    );
  }

  const requestId = `relay_${++relayRequestId}_${Date.now()}`;

  // Store the pending request in DynamoDB so we can route the response back
  await storePendingRelayRequest(requestId, clientConnectionId, jsonRpcId);

  // Send to relay
  await apiClient.send(
    new PostToConnectionCommand({
      ConnectionId: relayConnectionId,
      Data: Buffer.from(
        JSON.stringify({
          type: 'FIGMA_TOOL_CALL',
          relayRequestId: requestId,
          tool,
          args,
        })
      ),
    })
  );
}

// Store HTTP request response in DynamoDB for polling
async function storeHttpRequestResponse(
  requestId: string,
  success: boolean,
  result?: unknown,
  error?: string
): Promise<void> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  if (!tableName) return;

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { connectionId: { S: `http-request:${requestId}` } },
      UpdateExpression: 'SET #status = :status, #response = :response, #error = :error, completedAt = :completedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#response': 'response',
        '#error': 'error',
      },
      ExpressionAttributeValues: {
        ':status': { S: success ? 'completed' : 'error' },
        ':response': { S: success ? JSON.stringify(result) : '' },
        ':error': { S: error || '' },
        ':completedAt': { S: new Date().toISOString() },
      },
    })
  );
  console.info('Stored HTTP request response', { requestId, success });
}

// Handle response from Figma relay
async function handleFigmaRelayResponse(
  apiClient: ApiGatewayManagementApiClient,
  message: {
    relayRequestId: string;
    success: boolean;
    result?: unknown;
    error?: string;
    httpRequest?: boolean;
  }
): Promise<void> {
  // Check if this was an HTTP request (requestId starts with 'http_')
  const isHttpRequest = message.relayRequestId.startsWith('http_') || message.httpRequest;

  if (isHttpRequest) {
    // Store response in DynamoDB for HTTP handler to poll
    await storeHttpRequestResponse(
      message.relayRequestId,
      message.success,
      message.result,
      message.error
    );
    return;
  }

  // WebSocket request - look up pending request and send via WebSocket
  const pending = await getPendingRelayRequest(message.relayRequestId);
  if (!pending) {
    console.warn('Received relay response for unknown request', { relayRequestId: message.relayRequestId });
    return;
  }

  const { clientConnectionId, jsonRpcId } = pending;

  // Build JSON-RPC response
  let response;
  if (message.success) {
    response = {
      jsonrpc: '2.0',
      id: parseInt(jsonRpcId) || jsonRpcId,
      result: {
        content: [{ type: 'text', text: JSON.stringify(message.result, null, 2) }],
      },
    };
  } else {
    response = {
      jsonrpc: '2.0',
      id: parseInt(jsonRpcId) || jsonRpcId,
      error: {
        code: -32603,
        message: message.error || 'Unknown relay error',
      },
    };
  }

  // Send response back to original client
  try {
    await apiClient.send(
      new PostToConnectionCommand({
        ConnectionId: clientConnectionId,
        Data: Buffer.from(JSON.stringify(response)),
      })
    );
    console.info('Sent relay response to client', { clientConnectionId, jsonRpcId });
  } catch (error) {
    console.error('Failed to send relay response to client', { clientConnectionId, error });
  }
}

// Plugin-based Figma tools (require relay)
const PLUGIN_TOOLS = new Set([
  'dm_figma_get_document_info',
  'dm_figma_get_selection',
  'dm_figma_get_page',
  'dm_figma_set_page',
  'dm_figma_get_node_plugin',
  'dm_figma_get_children',
  'dm_figma_get_all_nodes',
  'dm_figma_update_node',
  'dm_figma_delete_node',
  'dm_figma_clone_node',
  'dm_figma_move_node',
  'dm_figma_group_nodes',
  'dm_figma_ungroup_nodes',
  'dm_figma_set_selection',
  'dm_figma_zoom_to_node',
  'dm_figma_create_frame',
  'dm_figma_create_text',
  'dm_figma_create_rectangle',
  'dm_figma_create_ellipse',
  'dm_figma_create_line',
  'dm_figma_create_auto_layout',
  'dm_figma_create_component',
  'dm_figma_create_screen',
  'dm_figma_export_node',
  'dm_figma_get_local_styles',
  'dm_figma_get_variables',
  'dm_figma_get_file_context',
  'dm_figma_validate_design',
]);

interface McpRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Load tokens at cold start
let designTokens: Record<string, unknown> | null = null;

function loadTokens(): Record<string, unknown> {
  if (designTokens) return designTokens;

  try {
    // Try to load from bundled resources
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const tokensPath = join(__dirname, '..', '..', 'mcp-server', 'src', 'resources', 'tokens.json');
    const content = readFileSync(tokensPath, 'utf-8');
    designTokens = JSON.parse(content);
    return designTokens!;
  } catch {
    // Return minimal token set if file not found
    designTokens = {
      global: {
        colors: {
          sky: { '500': { $value: '#3DBAFE' } },
          red: { '500': { $value: '#EF4444' } },
        },
      },
      light: {
        text: {
          primary: { $value: '#1A1A2E' },
          error: { $value: '#DC2626' },
        },
      },
    };
    return designTokens!;
  }
}

// Flatten tokens for listing
interface FlatToken {
  path: string;
  value: unknown;
  type?: string;
}

function flattenTokens(obj: Record<string, unknown>, prefix = ''): FlatToken[] {
  const result: FlatToken[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'object' && value !== null && '$value' in value) {
      result.push({
        path,
        value: (value as { $value: unknown }).$value,
        type: (value as { $type?: string }).$type,
      });
    } else if (typeof value === 'object' && value !== null) {
      result.push(...flattenTokens(value as Record<string, unknown>, path));
    }
  }

  return result;
}

function getTokenByPath(path: string): FlatToken | null {
  const tokens = loadTokens();
  const parts = path.split('.');
  let current: unknown = tokens;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'object' && current !== null && '$value' in current) {
    return {
      path,
      value: (current as { $value: unknown }).$value,
      type: (current as { $type?: string }).$type,
    };
  }

  return null;
}

// MCP Protocol handlers
async function handleInitialize(): Promise<unknown> {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'donatemate-mcp',
      version: '0.1.0',
    },
  };
}

async function handleToolsList(): Promise<unknown> {
  const tokenTools = [
    {
      name: 'dm_tokens_list',
      description: 'List all DonateMate design tokens',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Optional category filter (e.g., "global.colors", "light.text")',
          },
        },
      },
    },
    {
      name: 'dm_tokens_get',
      description: 'Get a specific design token by path',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Token path (e.g., "light.text.primary")',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'dm_tokens_search',
      description: 'Search design tokens by name or value',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'dm_tokens_categories',
      description: 'List all token categories',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  const figmaTools = [
    {
      name: 'dm_figma_get_file',
      description: 'Get Figma file structure and metadata. Returns document tree, components, and styles.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: {
            type: 'string',
            description: 'The Figma file key (from URL: figma.com/file/{fileKey}/...)',
          },
          depth: {
            type: 'number',
            description: 'How deep to traverse the document tree (default: 2)',
          },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_get_node',
      description: 'Get detailed information about specific nodes in a Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of node IDs to retrieve',
          },
          depth: { type: 'number', description: 'How deep to traverse children (default: 2)' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
    {
      name: 'dm_figma_get_components',
      description: 'List all components in a Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_get_styles',
      description: 'List all styles (colors, text, effects) in a Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_get_comments',
      description: 'Get all comments on a Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_post_comment',
      description: 'Add a comment to a Figma file. Optionally attach to a specific node.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          message: { type: 'string', description: 'The comment message' },
          nodeId: { type: 'string', description: 'Optional node ID to attach comment to' },
          x: { type: 'number', description: 'X position offset on the node' },
          y: { type: 'number', description: 'Y position offset on the node' },
        },
        required: ['fileKey', 'message'],
      },
    },
    {
      name: 'dm_figma_export',
      description: 'Export nodes as images. Returns URLs to download the exported images.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of node IDs to export',
          },
          format: {
            type: 'string',
            enum: ['jpg', 'png', 'svg', 'pdf'],
            description: 'Export format (default: png)',
          },
          scale: { type: 'number', description: 'Scale factor (0.01 to 4, default: 2)' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
    {
      name: 'dm_figma_get_team_projects',
      description: 'List all projects in a Figma team.',
      inputSchema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'The Figma team ID' },
        },
        required: ['teamId'],
      },
    },
    {
      name: 'dm_figma_get_project_files',
      description: 'List all files in a Figma project.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The Figma project ID' },
        },
        required: ['projectId'],
      },
    },
    // Branching tools - accept Figma URLs (just copy link from Figma)
    {
      name: 'dm_figma_list_branches',
      description: 'List all branches of a Figma file. Use this to see existing branches before creating a new one. Pass any Figma link from the file (copy link from Figma).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Any Figma URL from the file (e.g., https://www.figma.com/file/ABC123/File-Name or a node link)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'dm_figma_create_branch',
      description: 'Create a new branch from a Figma file. ALWAYS use this before making any design changes. Pass any Figma link from the file. Returns the branch URL to open in the Figma VM. When planning design updates, ensure you update ALL relevant UI states: empty state (no data), filled state (partial data), completed state (all fields correctly filled), and error state (validation failures). Apply changes consistently across all screen variations.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Any Figma URL from the file (e.g., https://www.figma.com/file/ABC123/File-Name or a node link)' },
          name: { type: 'string', description: 'Name for the new branch (e.g., "MCP-dashboard-enhancements")' },
        },
        required: ['url', 'name'],
      },
    },
    {
      name: 'dm_figma_delete_branch',
      description: 'Delete a branch from a Figma file. Use with caution - this cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Any Figma URL from the main file' },
          branchKey: { type: 'string', description: 'The branch key to delete (from dm_figma_list_branches)' },
        },
        required: ['url', 'branchKey'],
      },
    },
    {
      name: 'dm_figma_get_branch_info',
      description: 'Get information about a specific branch including its name, last modified time, and version.',
      inputSchema: {
        type: 'object',
        properties: {
          branchUrl: { type: 'string', description: 'The branch URL (from dm_figma_create_branch)' },
          depth: { type: 'number', description: 'How deep to traverse the document tree (default: 1)' },
        },
        required: ['branchUrl'],
      },
    },
  ];

  // Plugin-based Figma tools (require Figma Desktop + relay)
  // Architecture: Figma Desktop runs in an AWS Windows VM with the DonateMate Design Bridge plugin.
  // The plugin connects to a local relay agent, which bridges to this MCP server via WebSocket.
  const figmaPluginTools = [
    {
      name: 'dm_figma_get_document_info',
      description: 'Get information about the current Figma document including pages and selection. Figma Desktop runs in an AWS VM with the DonateMate Design Bridge plugin connected via relay.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_selection',
      description: 'Get the currently selected nodes in Figma. Requires Figma Desktop.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_page',
      description: 'Get information about the current page and its children. Requires Figma Desktop.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_set_page',
      description: 'Switch to a different page by ID or name. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Page ID to switch to' },
          pageName: { type: 'string', description: 'Page name to switch to' },
        },
      },
    },
    {
      name: 'dm_figma_get_children',
      description: 'Get the direct children of a specific node. Use this to explore the design hierarchy. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The parent node ID to get children from' },
          depth: { type: 'number', description: 'How deep to serialize each child (default: 1)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_get_all_nodes',
      description: 'Get all nodes on the current page with optional filtering. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', description: 'Filter by node type (FRAME, TEXT, RECTANGLE, etc.)' },
          namePattern: { type: 'string', description: 'Filter by name (case-insensitive contains)' },
          limit: { type: 'number', description: 'Maximum nodes to return (default 500)' },
        },
      },
    },
    {
      name: 'dm_figma_update_node',
      description: 'Update properties of an existing node (position, size, colors, text). IMPORTANT: (1) Always create a branch first using dm_figma_create_branch. (2) Update ALL related screen states (empty, filled, completed, error). (3) After completing changes, ALWAYS run dm_figma_validate_design to verify token usage and component consistency. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to update' },
          properties: { type: 'object', description: 'Properties to update: x, y, width, height, name, visible, opacity, fills, characters, fontSize, etc.' },
        },
        required: ['nodeId', 'properties'],
      },
    },
    {
      name: 'dm_figma_delete_node',
      description: 'Delete a node by ID. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to delete' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_clone_node',
      description: 'Clone/duplicate a node. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to clone' },
          newName: { type: 'string', description: 'Name for the cloned node' },
          offsetX: { type: 'number', description: 'X offset from original' },
          offsetY: { type: 'number', description: 'Y offset from original' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_create_frame',
      description: 'Create a new frame. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Frame name' },
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          width: { type: 'number', description: 'Width' },
          height: { type: 'number', description: 'Height' },
          fill: { type: 'string', description: 'Background color (hex)' },
          parentId: { type: 'string', description: 'Parent node ID' },
        },
        required: ['name', 'width', 'height'],
      },
    },
    {
      name: 'dm_figma_create_text',
      description: 'Create a text node. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          characters: { type: 'string', description: 'Text content' },
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          fontSize: { type: 'number', description: 'Font size' },
          fill: { type: 'string', description: 'Text color (hex)' },
          fontFamily: { type: 'string', description: 'Font family' },
          fontWeight: { type: 'number', description: 'Font weight' },
          parentId: { type: 'string', description: 'Parent node ID' },
        },
        required: ['characters'],
      },
    },
    {
      name: 'dm_figma_create_rectangle',
      description: 'Create a rectangle. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          width: { type: 'number', description: 'Width' },
          height: { type: 'number', description: 'Height' },
          fill: { type: 'string', description: 'Fill color (hex)' },
          cornerRadius: { type: 'number', description: 'Corner radius' },
          name: { type: 'string', description: 'Node name' },
          parentId: { type: 'string', description: 'Parent node ID' },
        },
        required: ['width', 'height'],
      },
    },
    {
      name: 'dm_figma_create_ellipse',
      description: 'Create an ellipse/circle. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          width: { type: 'number', description: 'Width' },
          height: { type: 'number', description: 'Height' },
          fill: { type: 'string', description: 'Fill color (hex)' },
          name: { type: 'string', description: 'Node name' },
          parentId: { type: 'string', description: 'Parent node ID' },
        },
        required: ['width', 'height'],
      },
    },
    {
      name: 'dm_figma_create_auto_layout',
      description: 'Create an auto-layout frame. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Frame name' },
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          layoutMode: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL'], description: 'Layout direction' },
          itemSpacing: { type: 'number', description: 'Spacing between items' },
          padding: { type: 'number', description: 'Padding' },
          fill: { type: 'string', description: 'Background color (hex)' },
          parentId: { type: 'string', description: 'Parent node ID' },
        },
        required: ['name', 'layoutMode'],
      },
    },
    {
      name: 'dm_figma_set_selection',
      description: 'Set the current selection to specific nodes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Array of node IDs to select' },
        },
        required: ['nodeIds'],
      },
    },
    {
      name: 'dm_figma_zoom_to_node',
      description: 'Zoom the viewport to focus on a specific node. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID to zoom to' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_move_node',
      description: 'Move a node to a new parent. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to move' },
          parentId: { type: 'string', description: 'The new parent node ID' },
          index: { type: 'number', description: 'Position within parent children (optional)' },
        },
        required: ['nodeId', 'parentId'],
      },
    },
    {
      name: 'dm_figma_group_nodes',
      description: 'Group multiple nodes together. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Array of node IDs to group' },
          name: { type: 'string', description: 'Name for the group' },
        },
        required: ['nodeIds'],
      },
    },
    {
      name: 'dm_figma_ungroup_nodes',
      description: 'Ungroup a group node. IMPORTANT: Always create a branch first using dm_figma_create_branch before making changes. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The group node ID to ungroup' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_get_node_plugin',
      description: 'Get detailed info about a node by ID using the plugin. Returns children up to specified depth. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to get info for' },
          depth: { type: 'number', description: 'How deep to traverse children (default: 3)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_export_node',
      description: 'Export a node as an image (PNG, JPG, SVG, PDF). Returns base64 encoded data. Requires Figma Desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to export' },
          format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'], description: 'Export format (default: PNG)' },
          scale: { type: 'number', description: 'Scale factor (default: 2)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_get_local_styles',
      description: 'Get all local paint, text, and effect styles. Requires Figma Desktop.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_variables',
      description: 'Get all local variable collections and their variables. Requires Figma Desktop.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_file_context',
      description: 'Get the current file context from the Figma plugin running in the AWS VM. Returns file name, editor type, page info, branch status hints, and the recommended branching workflow. Always call this first to understand the current state before making design changes. IMPORTANT: When updating designs, always consider ALL UI states where logically applicable: empty state, filled state, completed state (all fields correctly filled), and error state. For inputs, ensure all states are designed. For screens, ensure variations exist for different data scenarios.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_validate_design',
      description: 'REQUIRED: Call this after completing design changes to validate design consistency. Checks: (1) Design tokens are properly applied (colors, typography, spacing match token definitions), (2) Component consistency across screens (e.g., all back buttons, headers, inputs use the same established patterns), (3) Style uniformity (no one-off colors or fonts). Returns validation results with any inconsistencies found. Always run this before considering design work complete.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: Specific node IDs to validate. If not provided, validates current page.'
          },
          checkTokens: { type: 'boolean', description: 'Check design token usage (default: true)' },
          checkComponents: { type: 'boolean', description: 'Check component consistency (default: true)' },
          componentPatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Component name patterns to check for consistency (e.g., ["Back Button", "Header", "Input Field"])'
          },
        },
      },
    },
  ];

  return { tools: [...tokenTools, ...figmaTools, ...figmaPluginTools] };
}

async function handleToolsCall(
  params: Record<string, unknown>,
  apiClient?: ApiGatewayManagementApiClient,
  connectionId?: string,
  jsonRpcId?: number | string
): Promise<unknown> {
  const { name, arguments: args } = params as {
    name: string;
    arguments?: Record<string, unknown>;
  };

  // Check if this is a plugin-based tool that needs the relay
  if (PLUGIN_TOOLS.has(name)) {
    if (!apiClient || !connectionId || jsonRpcId === undefined) {
      throw new Error('API client, connectionId, and jsonRpcId required for relay routing');
    }
    // Send to relay - response will come back asynchronously
    await sendToFigmaRelay(apiClient, connectionId, jsonRpcId, name, args || {});
    // Return null to indicate response will be sent separately
    return null;
  }

  switch (name) {
    case 'dm_tokens_list': {
      const category = (args?.category as string) || '';
      const tokens = loadTokens();
      const flatTokens = flattenTokens(tokens).filter(
        (t) => !category || t.path.startsWith(category)
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: flatTokens.length, tokens: flatTokens }, null, 2),
          },
        ],
      };
    }

    case 'dm_tokens_get': {
      const path = args?.path as string;
      const token = getTokenByPath(path);

      if (!token) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Token not found: ${path}` }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(token, null, 2),
          },
        ],
      };
    }

    case 'dm_tokens_search': {
      const query = ((args?.query as string) || '').toLowerCase();
      const tokens = loadTokens();
      const flatTokens = flattenTokens(tokens).filter(
        (t) =>
          t.path.toLowerCase().includes(query) ||
          String(t.value).toLowerCase().includes(query)
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { query, count: flatTokens.length, tokens: flatTokens },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'dm_tokens_categories': {
      const tokens = loadTokens();
      const categories = Object.keys(tokens).filter((k) => !k.startsWith('$'));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ categories }, null, 2),
          },
        ],
      };
    }

    // ========================================================================
    // Figma Tools
    // ========================================================================

    case 'dm_figma_get_file': {
      const fileKey = args?.fileKey as string;
      const depth = (args?.depth as number) || 2;

      const file = await figmaRequest<FigmaFile>(`/files/${fileKey}?depth=${depth}`);

      const components = Object.entries(file.components).map(([id, comp]) => ({
        id,
        ...comp,
      }));
      const styles = Object.entries(file.styles).map(([id, style]) => ({
        id,
        ...style,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: file.name,
                lastModified: file.lastModified,
                version: file.version,
                document: file.document,
                components,
                styles,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case 'dm_figma_get_node': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const depth = (args?.depth as number) || 2;

      const idsParam = nodeIds.join(',');
      const data = await figmaRequest<{ nodes: Record<string, { document: FigmaNode }> }>(
        `/files/${fileKey}/nodes?ids=${idsParam}&depth=${depth}`
      );

      const nodes = Object.entries(data.nodes).map(([id, node]) => ({
        id,
        ...node.document,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ nodes }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_components': {
      const fileKey = args?.fileKey as string;

      const file = await figmaRequest<FigmaFile>(`/files/${fileKey}?depth=1`);
      const components = Object.entries(file.components).map(([id, comp]) => ({
        id,
        ...comp,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: components.length, components }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_styles': {
      const fileKey = args?.fileKey as string;

      const file = await figmaRequest<FigmaFile>(`/files/${fileKey}?depth=1`);
      const styles = Object.entries(file.styles).map(([id, style]) => ({
        id,
        ...style,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: styles.length, styles }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_comments': {
      const fileKey = args?.fileKey as string;

      const data = await figmaRequest<{ comments: FigmaComment[] }>(`/files/${fileKey}/comments`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: data.comments.length, comments: data.comments }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_post_comment': {
      const fileKey = args?.fileKey as string;
      const message = args?.message as string;
      const nodeId = args?.nodeId as string | undefined;
      const x = args?.x as number | undefined;
      const y = args?.y as number | undefined;

      interface CommentBody {
        message: string;
        client_meta?: { node_id?: string; node_offset?: { x: number; y: number } };
      }
      const body: CommentBody = { message };

      if (nodeId) {
        body.client_meta = { node_id: nodeId };
        if (x !== undefined && y !== undefined) {
          body.client_meta.node_offset = { x, y };
        }
      }

      const comment = await figmaRequest<FigmaComment>(`/files/${fileKey}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, comment }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_export': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const format = (args?.format as string) || 'png';
      const scale = (args?.scale as number) || 2;

      const idsParam = nodeIds.join(',');
      const data = await figmaRequest<{ images: Record<string, string> }>(
        `/images/${fileKey}?ids=${idsParam}&format=${format}&scale=${scale}`
      );

      const images = Object.entries(data.images).map(([nodeId, url]) => ({
        nodeId,
        url,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ format, scale, images }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_team_projects': {
      const teamId = args?.teamId as string;

      const data = await figmaRequest<{ projects: Array<{ id: string; name: string }> }>(
        `/teams/${teamId}/projects`
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: data.projects.length, projects: data.projects }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_project_files': {
      const projectId = args?.projectId as string;

      const data = await figmaRequest<{
        files: Array<{ key: string; name: string; thumbnail_url: string; last_modified: string }>;
      }>(`/projects/${projectId}/files`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: data.files.length, files: data.files }, null, 2),
          },
        ],
      };
    }

    // ========================================================================
    // Figma Branching Tools (REST API)
    // ========================================================================

    case 'dm_figma_list_branches': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);

      interface BranchInfo {
        key: string;
        name: string;
        thumbnail_url: string;
        last_modified: string;
        link_access: string;
      }

      const data = await figmaRequest<{ branches: BranchInfo[] }>(`/files/${fileKey}/branches`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              fileKey,
              count: data.branches?.length || 0,
              branches: (data.branches || []).map(b => ({
                ...b,
                branchUrl: `https://www.figma.com/file/${b.key}`,
              })),
              note: 'Use branchUrl to open a branch in Figma VM, or branchKey for other operations'
            }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_create_branch': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);
      const name = args?.name as string;

      interface CreateBranchResponse {
        key: string;
        name: string;
        thumbnail_url: string;
        last_modified: string;
      }

      const data = await figmaRequest<CreateBranchResponse>(`/files/${fileKey}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Branch "${name}" created successfully`,
              branch: data,
              branchUrl: `https://www.figma.com/file/${data.key}`,
              note: 'Open this URL in Figma to work on the branch. MCP changes should be made on this branch.'
            }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_delete_branch': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);
      const branchKey = args?.branchKey as string;

      await figmaRequest(`/files/${fileKey}/branches/${branchKey}`, {
        method: 'DELETE',
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Branch ${branchKey} deleted successfully`,
            }, null, 2),
          },
        ],
      };
    }

    case 'dm_figma_get_branch_info': {
      const branchUrl = args?.branchUrl as string;
      const { fileKey: branchKey } = parseFigmaUrl(branchUrl);
      const depth = (args?.depth as number) || 1;

      // A branch is accessed like a regular file using its branch key
      const file = await figmaRequest<FigmaFile>(`/files/${branchKey}?depth=${depth}&branch_data=true`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: file.name,
              lastModified: file.lastModified,
              version: file.version,
              isBranch: true,
              branchKey,
              branchUrl,
            }, null, 2),
          },
        ],
      };
    }

    default:
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
          },
        ],
        isError: true,
      };
  }
}

async function processMessage(
  request: McpRequest,
  connectionId: string,
  apiClient: ApiGatewayManagementApiClient
): Promise<McpResponse | null> {
  try {
    let result: unknown;

    switch (request.method) {
      case 'initialize':
        result = await handleInitialize();
        break;
      case 'tools/list':
        result = await handleToolsList();
        break;
      case 'tools/call':
        result = await handleToolsCall(request.params || {}, apiClient, connectionId, request.id);
        break;
      case 'ping':
        result = {};
        break;
      case 'relay/register':
        // Register this connection as the Figma relay
        await registerFigmaRelay(connectionId);
        result = { registered: true, type: 'figma' };
        break;
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }

    // If result is null, the response will be sent separately (async relay response)
    if (result === null) {
      return null;
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result,
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}

async function sendResponse(
  apiClient: ApiGatewayManagementApiClient,
  connectionId: string,
  response: McpResponse
): Promise<void> {
  try {
    await apiClient.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(response)),
      })
    );
  } catch (error) {
    console.error('Failed to send response', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  const { domainName, stage } = event.requestContext;

  // Create API Gateway management client for sending responses
  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  // Update last activity timestamp
  if (tableName) {
    try {
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { connectionId: { S: connectionId } },
          UpdateExpression: 'SET lastActivityAt = :now',
          ExpressionAttributeValues: {
            ':now': { S: new Date().toISOString() },
          },
        })
      );
    } catch {
      // Ignore update errors
    }
  }

  // Parse incoming message
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(event.body || '{}');
  } catch {
    const errorResponse: McpResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error: invalid JSON',
      },
    };
    await sendResponse(apiClient, connectionId, errorResponse);
    return { statusCode: 200, body: 'OK' };
  }

  // Check if this is a Figma relay response (not JSON-RPC)
  if (message.type === 'FIGMA_RESPONSE') {
    console.info('Received Figma relay response', { relayRequestId: message.relayRequestId, httpRequest: message.httpRequest });
    await handleFigmaRelayResponse(apiClient, message as {
      relayRequestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
      httpRequest?: boolean;
    });
    return { statusCode: 200, body: 'OK' };
  }

  // Cast to MCP request for JSON-RPC handling
  const request = message as McpRequest;

  // Validate JSON-RPC structure
  if (request.jsonrpc !== '2.0' || !request.method) {
    const errorResponse: McpResponse = {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32600,
        message: 'Invalid Request: missing jsonrpc or method',
      },
    };
    await sendResponse(apiClient, connectionId, errorResponse);
    return { statusCode: 200, body: 'OK' };
  }

  // Process the message
  console.info('Processing MCP request', {
    connectionId,
    method: request.method,
    id: request.id,
  });

  // Notifications (methods starting with "notifications/") don't expect responses
  if (request.method.startsWith('notifications/')) {
    console.info('Received notification, no response needed', { method: request.method });
    return { statusCode: 200, body: 'OK' };
  }

  const response = await processMessage(request, connectionId, apiClient);

  // Send response back to client
  if (response) {
    await sendResponse(apiClient, connectionId, response);
  }

  return { statusCode: 200, body: 'OK' };
}
