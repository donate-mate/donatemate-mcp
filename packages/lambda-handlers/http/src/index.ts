/**
 * MCP HTTP Transport Handler - Full Access
 *
 * This handler provides full MCP functionality over HTTP transport,
 * bridging to the WebSocket relay for Figma plugin operations.
 *
 * Authentication: API Key (dm_xxx) in Authorization header as Bearer token
 *
 * All Claude clients (Web, Desktop, Code) get full access to:
 * - Design tokens
 * - Figma REST API (branching, comments, export)
 * - Figma Plugin (create, update, delete nodes) via relay bridge
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHash, createVerify } from 'crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const ssmClient = new SSMClient({});
const lambdaClient = new LambdaClient({});

// Knowledge base search function ARN cache
let knowledgeSearchArn = '';

async function getKnowledgeSearchArn(): Promise<string> {
  if (knowledgeSearchArn) return knowledgeSearchArn;
  const paramName = `/donatemate/${process.env.ENVIRONMENT || 'staging'}/knowledge/search-function-arn`;
  try {
    const response = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    knowledgeSearchArn = response.Parameter?.Value || '';
  } catch (error) {
    console.warn('[knowledge] Failed to get search function ARN:', error);
  }
  return knowledgeSearchArn;
}

async function invokeKnowledgeSearch(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const functionArn = await getKnowledgeSearchArn();
  if (!functionArn) {
    return { error: 'Knowledge base not configured', total: 0, results: [] };
  }

  let payload: Record<string, unknown>;

  if (toolName === 'dm_knowledge_search') {
    // Build date range filter if provided
    const dateRange = (args.startDate || args.endDate) ? {
      start: args.startDate as string | undefined,
      end: args.endDate as string | undefined,
    } : undefined;

    payload = {
      httpMethod: 'POST',
      path: '/search',
      body: JSON.stringify({
        query: args.query,
        filters: {
          sourceTypes: args.sources,
          projectKeys: args.project ? [args.project] : undefined,
          dateRange,
        },
        limit: Math.min((args.limit as number) || 10, 50),
      }),
    };
  } else if (toolName === 'dm_knowledge_context') {
    const limitMap: Record<string, number> = { brief: 5, detailed: 15, comprehensive: 30 };
    payload = {
      httpMethod: 'POST',
      path: '/search',
      body: JSON.stringify({
        query: args.topic,
        limit: limitMap[(args.depth as string) || 'detailed'] || 15,
        includeContent: true,
      }),
    };
  } else {
    payload = { httpMethod: 'GET', path: '/stats' };
  }

  const response = await lambdaClient.send(
    new InvokeCommand({ FunctionName: functionArn, Payload: JSON.stringify(payload) })
  );

  const responsePayload = JSON.parse(new TextDecoder().decode(response.Payload));
  return JSON.parse(responsePayload.body || '{}');
}

// API key prefix for identification
const API_KEY_PREFIX = 'dm_';

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

// ============================================================================
// Authentication
// ============================================================================

interface AuthResult {
  userId: string;
  email: string;
  keyHash: string;
  authMethod: 'api-key' | 'oauth';
}

// OAuth rate limit: 2000 requests per hour (higher for authenticated users via browser)
const OAUTH_RATE_LIMIT = 2000;
// Default rate limit: 1000 requests per hour per key
const DEFAULT_RATE_LIMIT = 1000;
const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour

async function validateApiKey(apiKey: string): Promise<AuthResult | null> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) {
    console.error('API_KEYS_TABLE_NAME not configured');
    return null;
  }

  // Hash the API key for lookup (keys are stored as hashes)
  const keyHash = hashApiKey(apiKey);

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        keyHash: { S: keyHash },
      },
    })
  );

  if (!result.Item) {
    console.warn('API key not found', { keyPrefix: apiKey.substring(0, 8) });
    return null;
  }

  // Check expiration (expiresAt is Unix timestamp in seconds)
  const expiresAt = result.Item.expiresAt?.N;
  if (expiresAt) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= parseInt(expiresAt, 10)) {
      console.warn('API key expired', { keyPrefix: apiKey.substring(0, 8) });
      return null;
    }
  }

  // Check if key is revoked
  if (result.Item.revoked?.BOOL) {
    console.warn('API key revoked', { keyPrefix: apiKey.substring(0, 8) });
    return null;
  }

  // Check rate limit
  const rateLimit = parseInt(result.Item.rateLimit?.N || String(DEFAULT_RATE_LIMIT), 10);
  const currentWindowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS;
  const windowKey = `window_${currentWindowStart}`;
  const currentCount = parseInt(result.Item[windowKey]?.N || '0', 10);

  if (currentCount >= rateLimit) {
    console.warn('Rate limit exceeded', {
      keyPrefix: apiKey.substring(0, 8),
      count: currentCount,
      limit: rateLimit
    });
    return null;
  }

  return {
    userId: result.Item.userId?.S || 'unknown',
    email: result.Item.email?.S || result.Item.name?.S || 'api-key-user',
    keyHash,
    authMethod: 'api-key',
  };
}

// ============================================================================
// OAuth JWT Validation (for Claude.ai Web)
// ============================================================================

// JWKS cache - keys are cached for 1 hour
interface JwkKey {
  kid: string;
  kty: string;
  use: string;
  n: string;
  e: string;
  alg: string;
}

interface JwksCache {
  keys: JwkKey[];
  fetchedAt: number;
}

const jwksCaches: Map<string, JwksCache> = new Map();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getJwks(issuer: string): Promise<JwkKey[]> {
  const cached = jwksCaches.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${response.status}`);
  }

  const jwks = await response.json() as { keys: JwkKey[] };
  jwksCaches.set(issuer, { keys: jwks.keys, fetchedAt: Date.now() });
  return jwks.keys;
}

function base64UrlDecode(str: string): Buffer {
  // Base64URL to Base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

function rsaPublicKeyPem(n: string, e: string): string {
  // Convert JWK to PEM format
  const nBuf = base64UrlDecode(n);
  const eBuf = base64UrlDecode(e);

  // Build RSA public key in DER format
  const sequence = (tag: number, content: Buffer): Buffer => {
    const len = content.length;
    if (len < 128) {
      return Buffer.concat([Buffer.from([tag, len]), content]);
    } else if (len < 256) {
      return Buffer.concat([Buffer.from([tag, 0x81, len]), content]);
    } else {
      return Buffer.concat([Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]), content]);
    }
  };

  const integer = (buf: Buffer): Buffer => {
    // Add leading zero if high bit is set (to indicate positive number)
    if (buf[0] & 0x80) {
      buf = Buffer.concat([Buffer.from([0]), buf]);
    }
    return sequence(0x02, buf);
  };

  const rsaPublicKey = sequence(0x30, Buffer.concat([integer(nBuf), integer(eBuf)]));

  // RSA OID
  const rsaOid = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

  // BitString wrapper
  const bitString = Buffer.concat([Buffer.from([0x00]), rsaPublicKey]);
  const bitStringWrapped = sequence(0x03, bitString);

  const publicKeyInfo = sequence(0x30, Buffer.concat([rsaOid, bitStringWrapped]));

  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKeyInfo.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  return pem;
}

interface JwtPayload {
  sub: string;
  email?: string;
  aud?: string | string[];
  client_id?: string; // Cognito access tokens use client_id instead of aud
  iss: string;
  exp: number;
  iat: number;
  token_use?: string;
  'custom:mcp_access'?: string;
}

async function validateOAuthToken(token: string): Promise<AuthResult | null> {
  const oauthUserPoolId = process.env.OAUTH_USER_POOL_ID;
  const mcpAudience = process.env.MCP_SERVER_AUDIENCE || 'https://mcp.donate-mate.com';
  const region = process.env.AWS_REGION || 'us-east-2';

  if (!oauthUserPoolId) {
    console.warn('OAuth not configured - OAUTH_USER_POOL_ID not set');
    return null;
  }

  const issuer = `https://cognito-idp.${region}.amazonaws.com/${oauthUserPoolId}`;

  try {
    // Split JWT
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.warn('Invalid JWT format');
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as JwtPayload;

    // Verify issuer
    if (payload.iss !== issuer) {
      console.warn('Invalid issuer', { expected: issuer, got: payload.iss });
      return null;
    }

    // Verify expiration
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp < nowSeconds) {
      console.warn('Token expired', { exp: payload.exp, now: nowSeconds });
      return null;
    }

    // Verify audience/client binding
    // Cognito access tokens use client_id, ID tokens use aud
    // For access tokens: verify client_id matches our OAuth client
    // For ID tokens: verify aud contains our client_id or MCP audience
    const oauthClientId = process.env.OAUTH_CLIENT_ID;
    const audClaim = payload.aud;
    const clientIdClaim = payload.client_id;

    // Access token validation (has client_id, token_use: "access")
    if (payload.token_use === 'access' && clientIdClaim) {
      if (clientIdClaim !== oauthClientId) {
        console.warn('Invalid client_id', { expected: oauthClientId, got: clientIdClaim });
        return null;
      }
    }
    // ID token validation (has aud)
    else if (audClaim) {
      const audiences = Array.isArray(audClaim) ? audClaim : [audClaim];
      // ID token aud should be the client_id
      if (!audiences.includes(oauthClientId || '') && !audiences.includes(mcpAudience)) {
        console.warn('Invalid audience', { expected: [oauthClientId, mcpAudience], got: audClaim });
        return null;
      }
    }
    // Neither - invalid token
    else {
      console.warn('Token missing both aud and client_id claims');
      return null;
    }

    // Fetch JWKS and find matching key
    const jwks = await getJwks(issuer);
    const key = jwks.find(k => k.kid === header.kid);
    if (!key) {
      console.warn('Key not found in JWKS', { kid: header.kid });
      return null;
    }

    // Verify signature
    const signData = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);
    const publicKey = rsaPublicKeyPem(key.n, key.e);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signData);
    const isValid = verifier.verify(publicKey, signature);

    if (!isValid) {
      console.warn('Invalid JWT signature');
      return null;
    }

    console.info('OAuth token validated', { sub: payload.sub, email: payload.email });

    return {
      userId: payload.sub,
      email: payload.email || 'oauth-user',
      keyHash: `oauth:${payload.sub}`, // Use sub as identifier for rate limiting
      authMethod: 'oauth',
    };
  } catch (error) {
    console.error('OAuth token validation error', { error });
    return null;
  }
}

async function trackRequest(keyHash: string): Promise<void> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) return;

  const currentWindowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS;
  const windowKey = `window_${currentWindowStart}`;
  const prevWindowKey = `window_${currentWindowStart - RATE_LIMIT_WINDOW_SECONDS}`;

  try {
    // Increment current window counter and clean up old window
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { keyHash: { S: keyHash } },
        UpdateExpression: `SET ${windowKey} = if_not_exists(${windowKey}, :zero) + :one, lastRequestAt = :now REMOVE ${prevWindowKey}`,
        ExpressionAttributeValues: {
          ':zero': { N: '0' },
          ':one': { N: '1' },
          ':now': { S: new Date().toISOString() },
        },
      })
    );
  } catch (error) {
    // Non-fatal - don't fail the request if tracking fails
    console.error('Failed to track request', { error });
  }
}

interface ExtractedToken {
  type: 'api-key' | 'oauth';
  value: string;
}

function extractToken(event: APIGatewayProxyEventV2): ExtractedToken | null {
  // Check Authorization header (Bearer token)
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.startsWith(API_KEY_PREFIX)) {
      return { type: 'api-key', value: token };
    }
    // Assume JWT format for OAuth tokens (contains dots)
    if (token.includes('.')) {
      return { type: 'oauth', value: token };
    }
  }

  // Check query parameter (for API keys only - MCP spec prohibits tokens in URLs)
  const queryToken = event.queryStringParameters?.token;
  if (queryToken?.startsWith(API_KEY_PREFIX)) {
    return { type: 'api-key', value: queryToken };
  }

  return null;
}

// Helper to get WWW-Authenticate header value per MCP OAuth spec
function getWwwAuthenticateHeader(): string {
  const oauthUserPoolId = process.env.OAUTH_USER_POOL_ID;
  const region = process.env.AWS_REGION || 'us-east-2';

  if (oauthUserPoolId) {
    const resourceMetadataUrl = 'https://mcp.donate-mate.com/.well-known/oauth-protected-resource';
    return `Bearer resource_metadata="${resourceMetadataUrl}"`;
  }

  return 'Bearer';
}

// ============================================================================
// Figma Client
// ============================================================================

const FIGMA_API_BASE = 'https://api.figma.com/v1';

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
    throw new Error(`Figma token not configured.`);
  }

  cachedFigmaToken = token;
  return token;
}

async function figmaRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = await getFigmaToken();
  const url = `${FIGMA_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { 'X-Figma-Token': token, ...options.headers },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Figma API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Figma URL Parser
// ============================================================================

interface ParsedFigmaUrl {
  fileKey: string;
  nodeId?: string;
  fileName?: string;
}

function parseFigmaUrl(url: string): ParsedFigmaUrl {
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

  throw new Error(`Invalid Figma URL: ${url}`);
}

// ============================================================================
// Figma Relay Bridge (for plugin-based tools)
// ============================================================================

let relayRequestId = 0;

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

async function sendToRelayAndWait(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number = 30000
): Promise<unknown> {
  const tableName = process.env.CONNECTIONS_TABLE_NAME;
  const wsEndpoint = process.env.WEBSOCKET_ENDPOINT;

  if (!tableName || !wsEndpoint) {
    throw new Error('Relay not configured');
  }

  const relayConnectionId = await getFigmaRelayConnectionId();
  if (!relayConnectionId) {
    throw new Error(
      'Figma relay not connected. The Figma Desktop plugin must be running in the AWS VM with the relay agent connected.'
    );
  }

  const requestId = `http_${++relayRequestId}_${Date.now()}`;

  // Store pending request
  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        connectionId: { S: `http-request:${requestId}` },
        status: { S: 'pending' },
        createdAt: { S: new Date().toISOString() },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 120) },
      },
    })
  );

  // Send to relay via WebSocket API Gateway
  const apiClient = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  await apiClient.send(
    new PostToConnectionCommand({
      ConnectionId: relayConnectionId,
      Data: Buffer.from(
        JSON.stringify({
          type: 'FIGMA_TOOL_CALL',
          relayRequestId: requestId,
          tool,
          args,
          httpRequest: true, // Flag so relay knows to store response
        })
      ),
    })
  );

  // Poll for response
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms between polls

    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { connectionId: { S: `http-request:${requestId}` } },
      })
    );

    if (result.Item?.status?.S === 'completed') {
      // Clean up
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { connectionId: { S: `http-request:${requestId}` } },
        })
      );

      const responseData = result.Item.response?.S;
      if (responseData) {
        return JSON.parse(responseData);
      }
      throw new Error('Empty response from relay');
    }

    if (result.Item?.status?.S === 'error') {
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { connectionId: { S: `http-request:${requestId}` } },
        })
      );
      throw new Error(result.Item.error?.S || 'Relay error');
    }
  }

  throw new Error('Timeout waiting for Figma plugin response');
}

// Plugin-based tools
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

// ============================================================================
// MCP Protocol
// ============================================================================

const MCP_PROTOCOL_VERSION = '2025-06-18';

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
  error?: { code: number; message: string; data?: unknown };
}

// Generate a cryptographically secure session ID
function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function handleInitialize(): Promise<unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'donatemate-mcp', version: '0.1.0' },
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
          category: { type: 'string', description: 'Optional category filter' },
        },
      },
    },
    {
      name: 'dm_tokens_get',
      description: 'Get a specific design token by path',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Token path' } },
        required: ['path'],
      },
    },
    {
      name: 'dm_tokens_search',
      description: 'Search design tokens by name or value',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  ];

  const figmaRestTools = [
    {
      name: 'dm_figma_get_file',
      description: 'Get Figma file structure and metadata via REST API.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          depth: { type: 'number', description: 'Traversal depth (default: 2)' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_get_node',
      description: 'Get specific nodes from a Figma file via REST API.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node IDs' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
    {
      name: 'dm_figma_list_branches',
      description: 'List all branches of a Figma file.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Any Figma URL from the file' } },
        required: ['url'],
      },
    },
    {
      name: 'dm_figma_create_branch',
      description: 'Create a new branch. ALWAYS use this before making design changes.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Any Figma URL from the file' },
          name: { type: 'string', description: 'Branch name' },
        },
        required: ['url', 'name'],
      },
    },
    {
      name: 'dm_figma_get_comments',
      description: 'Get all comments on a Figma file.',
      inputSchema: {
        type: 'object',
        properties: { fileKey: { type: 'string', description: 'The Figma file key' } },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_post_comment',
      description: 'Add a comment to a Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          message: { type: 'string', description: 'Comment message' },
          nodeId: { type: 'string', description: 'Optional node ID' },
        },
        required: ['fileKey', 'message'],
      },
    },
    {
      name: 'dm_figma_export',
      description: 'Export nodes as images via REST API.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'The Figma file key' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node IDs' },
          format: { type: 'string', enum: ['jpg', 'png', 'svg', 'pdf'] },
          scale: { type: 'number', description: 'Scale factor' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
  ];

  // Plugin-based tools (full Figma editing)
  const figmaPluginTools = [
    {
      name: 'dm_figma_get_document_info',
      description: 'Get current Figma document info. Figma Desktop runs in AWS VM with plugin.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_file_context',
      description: 'Get file context including architecture info and design guidelines. Call this first before making changes.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_selection',
      description: 'Get currently selected nodes in Figma.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_page',
      description: 'Get current page info and children.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_set_page',
      description: 'Switch to a different page.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Page ID' },
          pageName: { type: 'string', description: 'Page name' },
        },
      },
    },
    {
      name: 'dm_figma_get_children',
      description: 'Get children of a node.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Parent node ID' },
          depth: { type: 'number', description: 'Depth (default: 1)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_get_all_nodes',
      description: 'Get all nodes on current page with optional filtering.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', description: 'Filter by type' },
          namePattern: { type: 'string', description: 'Filter by name' },
          limit: { type: 'number', description: 'Max nodes (default: 500)' },
        },
      },
    },
    {
      name: 'dm_figma_update_node',
      description: 'Update node properties. IMPORTANT: Create branch first, update ALL screen states, then validate.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID' },
          properties: { type: 'object', description: 'Properties to update' },
        },
        required: ['nodeId', 'properties'],
      },
    },
    {
      name: 'dm_figma_delete_node',
      description: 'Delete a node. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: { nodeId: { type: 'string', description: 'Node ID' } },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_clone_node',
      description: 'Clone/duplicate a node. By default clone appears as sibling; use parentId to clone directly INTO a target frame (more efficient than clone + move). Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID to clone' },
          newName: { type: 'string', description: 'Name for the cloned node' },
          parentId: { type: 'string', description: 'Optional: target parent frame ID - clone will be created inside this frame' },
          offsetX: { type: 'number', description: 'X position (absolute if parentId, offset if not)' },
          offsetY: { type: 'number', description: 'Y position (absolute if parentId, offset if not)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_move_node',
      description: 'REPARENT a node - move it INTO a different parent frame. This IS supported by Figma Plugin API using appendChild(). Use this to restructure the hierarchy: move a cloned nav bar INTO a frame, nest components inside containers, etc. Workflow: clone_node creates sibling, then move_node reparents it into target frame. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID to move/reparent' },
          parentId: { type: 'string', description: 'Target parent frame ID - the node will become a child of this frame' },
          index: { type: 'number', description: 'Optional: position in parent children array (0 = first child)' },
        },
        required: ['nodeId', 'parentId'],
      },
    },
    {
      name: 'dm_figma_create_frame',
      description: 'Create a new frame. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string', description: 'Background color (hex)' },
          parentId: { type: 'string' },
        },
        required: ['name', 'width', 'height'],
      },
    },
    {
      name: 'dm_figma_create_text',
      description: 'Create a text node. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          characters: { type: 'string', description: 'Text content' },
          x: { type: 'number' },
          y: { type: 'number' },
          fontSize: { type: 'number' },
          fill: { type: 'string', description: 'Text color (hex)' },
          parentId: { type: 'string' },
        },
        required: ['characters'],
      },
    },
    {
      name: 'dm_figma_create_rectangle',
      description: 'Create a rectangle. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string' },
          cornerRadius: { type: 'number' },
          name: { type: 'string' },
          parentId: { type: 'string' },
        },
        required: ['width', 'height'],
      },
    },
    {
      name: 'dm_figma_validate_design',
      description: 'REQUIRED: Validate design after changes. Checks token usage and component consistency.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node IDs to validate' },
          checkTokens: { type: 'boolean' },
          checkComponents: { type: 'boolean' },
          componentPatterns: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'dm_figma_get_local_styles',
      description: 'Get all local paint, text, and effect styles.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_variables',
      description: 'Get all local variable collections.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  const knowledgeTools = [
    {
      name: 'dm_knowledge_search',
      description: `Search the DonateMate organizational knowledge base. This includes:
- **Code**: GitHub repositories (donatemate-app, donatemate-lambdas)
- **Issues**: Jira tickets, bugs, and feature requests
- **Documentation**: Confluence pages and wikis
- **Discussions**: Important Slack messages and threads

Use this to find relevant context about DonateMate's codebase, architecture, decisions, and processes.

**Date Filtering**: Use startDate/endDate for time-based queries like "messages from today" or "updates this week".`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['github', 'jira', 'confluence', 'slack'] },
            description: 'Optional: filter to specific sources',
          },
          project: { type: 'string', description: 'Optional: filter to a specific project' },
          limit: { type: 'number', description: 'Max results (default: 10, max: 50)' },
          startDate: {
            type: 'string',
            description: 'Optional: filter to items created on or after this date (ISO 8601 format, e.g., "2026-01-12" or "2026-01-12T00:00:00Z")'
          },
          endDate: {
            type: 'string',
            description: 'Optional: filter to items created on or before this date (ISO 8601 format, e.g., "2026-01-13" or "2026-01-13T23:59:59Z")'
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'dm_knowledge_context',
      description: 'Get comprehensive context about a DonateMate topic from all knowledge sources.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic to get context about' },
          depth: { type: 'string', enum: ['brief', 'detailed', 'comprehensive'] },
        },
        required: ['topic'],
      },
    },
    {
      name: 'dm_knowledge_stats',
      description: 'Get statistics about the knowledge base indexed content.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  return { tools: [...tokenTools, ...figmaRestTools, ...figmaPluginTools, ...knowledgeTools] };
}

// Simple token storage
const designTokens: Record<string, unknown> = {
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

interface FlatToken { path: string; value: unknown; type?: string; }

function flattenTokens(obj: Record<string, unknown>, prefix = ''): FlatToken[] {
  const result: FlatToken[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && '$value' in value) {
      result.push({ path, value: (value as any).$value, type: (value as any).$type });
    } else if (typeof value === 'object' && value !== null) {
      result.push(...flattenTokens(value as Record<string, unknown>, path));
    }
  }
  return result;
}

async function handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
  const { name, arguments: args } = params as { name: string; arguments?: Record<string, unknown> };

  // Plugin-based tools - route through relay
  if (PLUGIN_TOOLS.has(name)) {
    try {
      const result = await sendToRelayAndWait(name, args || {});
      // Use compact JSON to reduce response size and context window usage
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        isError: true,
      };
    }
  }

  // REST API and token tools
  switch (name) {
    case 'dm_tokens_list': {
      const category = (args?.category as string) || '';
      const flatTokens = flattenTokens(designTokens).filter(t => !category || t.path.startsWith(category));
      return { content: [{ type: 'text', text: JSON.stringify({ count: flatTokens.length, tokens: flatTokens }, null, 2) }] };
    }

    case 'dm_tokens_search': {
      const query = ((args?.query as string) || '').toLowerCase();
      const flatTokens = flattenTokens(designTokens).filter(
        t => t.path.toLowerCase().includes(query) || String(t.value).toLowerCase().includes(query)
      );
      return { content: [{ type: 'text', text: JSON.stringify({ query, count: flatTokens.length, tokens: flatTokens }, null, 2) }] };
    }

    case 'dm_tokens_get': {
      const path = args?.path as string;
      const flatTokens = flattenTokens(designTokens);
      const token = flatTokens.find(t => t.path === path);
      if (!token) return { content: [{ type: 'text', text: JSON.stringify({ error: `Token not found: ${path}` }) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(token, null, 2) }] };
    }

    case 'dm_figma_get_file': {
      const fileKey = args?.fileKey as string;
      const depth = (args?.depth as number) || 2;
      const file = await figmaRequest<any>(`/files/${fileKey}?depth=${depth}`);
      return { content: [{ type: 'text', text: JSON.stringify({ name: file.name, lastModified: file.lastModified, document: file.document }, null, 2) }] };
    }

    case 'dm_figma_get_node': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const data = await figmaRequest<any>(`/files/${fileKey}/nodes?ids=${nodeIds.join(',')}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'dm_figma_list_branches': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);
      const data = await figmaRequest<any>(`/files/${fileKey}/branches`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            fileKey,
            count: data.branches?.length || 0,
            branches: (data.branches || []).map((b: any) => ({ ...b, branchUrl: `https://www.figma.com/file/${b.key}` })),
          }, null, 2),
        }],
      };
    }

    case 'dm_figma_create_branch': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);
      const branchName = args?.name as string;
      const data = await figmaRequest<any>(`/files/${fileKey}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: branchName }),
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Branch "${branchName}" created`,
            branch: data,
            branchUrl: `https://www.figma.com/file/${data.key}`,
          }, null, 2),
        }],
      };
    }

    case 'dm_figma_get_comments': {
      const fileKey = args?.fileKey as string;
      const data = await figmaRequest<any>(`/files/${fileKey}/comments`);
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.comments.length, comments: data.comments }, null, 2) }] };
    }

    case 'dm_figma_post_comment': {
      const fileKey = args?.fileKey as string;
      const message = args?.message as string;
      const nodeId = args?.nodeId as string | undefined;
      const body: any = { message };
      if (nodeId) body.client_meta = { node_id: nodeId };
      const comment = await figmaRequest<any>(`/files/${fileKey}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, comment }, null, 2) }] };
    }

    case 'dm_figma_export': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const format = (args?.format as string) || 'png';
      const scale = (args?.scale as number) || 2;
      const data = await figmaRequest<any>(`/images/${fileKey}?ids=${nodeIds.join(',')}&format=${format}&scale=${scale}`);
      return { content: [{ type: 'text', text: JSON.stringify({ format, scale, images: data.images }, null, 2) }] };
    }

    // Knowledge base tools
    case 'dm_knowledge_search':
    case 'dm_knowledge_context':
    case 'dm_knowledge_stats': {
      const result = await invokeKnowledgeSearch(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }
}

async function processMessage(request: McpRequest): Promise<McpResponse> {
  try {
    let result: unknown;
    switch (request.method) {
      case 'initialize': result = await handleInitialize(); break;
      case 'tools/list': result = await handleToolsList(); break;
      case 'tools/call': result = await handleToolsCall(request.params || {}); break;
      case 'ping': result = {}; break;
      default:
        return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error) {
    return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' } };
  }
}

// ============================================================================
// HTTP Handler
// ============================================================================

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Base headers for all responses - MCP Streamable HTTP compliance
  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  };

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: baseHeaders, body: '' };
  }

  // Health check - no auth required (separate from MCP protocol)
  if (path.endsWith('/health') && method === 'GET') {
    return {
      statusCode: 200,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'healthy', transport: 'streamable-http', protocolVersion: MCP_PROTOCOL_VERSION }),
    };
  }

  // OAuth Protected Resource Metadata endpoint (MCP OAuth 2.1 spec requirement)
  // Claude.ai uses this to discover authorization servers
  if (path.endsWith('/.well-known/oauth-protected-resource') && method === 'GET') {
    const oauthDomain = process.env.OAUTH_DOMAIN;
    const region = process.env.AWS_REGION || 'us-east-2';

    // Point to our own authorization server metadata which advertises DCR
    const authorizationServer = oauthDomain
      ? `https://mcp.donate-mate.com`
      : null;

    const metadata = {
      resource: 'https://mcp.donate-mate.com',
      authorization_servers: authorizationServer ? [authorizationServer] : [],
      scopes_supported: ['openid', 'profile', 'email', 'mcp.donate-mate.com/read', 'mcp.donate-mate.com/write'],
      bearer_methods_supported: ['header'],
    };

    return {
      statusCode: 200,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    };
  }

  // OAuth Authorization Server Metadata endpoint (RFC 8414)
  // Claude.ai fetches this to discover OAuth endpoints including DCR
  if (path.endsWith('/.well-known/oauth-authorization-server') && method === 'GET') {
    const oauthDomain = process.env.OAUTH_DOMAIN;
    const oauthClientId = process.env.OAUTH_CLIENT_ID;
    const region = process.env.AWS_REGION || 'us-east-2';

    if (!oauthDomain) {
      return {
        statusCode: 503,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'OAuth not configured' }),
      };
    }

    const cognitoBaseUrl = `https://${oauthDomain}.auth.${region}.amazoncognito.com`;

    // OAuth Authorization Server Metadata per RFC 8414 + DCR per RFC 7591
    const metadata = {
      issuer: 'https://mcp.donate-mate.com',
      authorization_endpoint: `${cognitoBaseUrl}/oauth2/authorize`,
      token_endpoint: `${cognitoBaseUrl}/oauth2/token`,
      userinfo_endpoint: `${cognitoBaseUrl}/oauth2/userInfo`,
      revocation_endpoint: `${cognitoBaseUrl}/oauth2/revoke`,
      jwks_uri: `${cognitoBaseUrl}/.well-known/jwks.json`,
      // DCR endpoint - required by Claude.ai per MCP spec
      registration_endpoint: 'https://mcp.donate-mate.com/oauth/register',
      scopes_supported: ['openid', 'profile', 'email', 'mcp.donate-mate.com/read', 'mcp.donate-mate.com/write'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], // Public client (PKCE)
      code_challenge_methods_supported: ['S256'],
      // Indicate DCR is supported
      registration_endpoint_auth_methods_supported: ['none'],
    };

    return {
      statusCode: 200,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    };
  }

  // Dynamic Client Registration endpoint (RFC 7591)
  // Claude.ai requires this per MCP OAuth spec - we return pre-configured client
  if (path.endsWith('/oauth/register') && method === 'POST') {
    const oauthClientId = process.env.OAUTH_CLIENT_ID;
    const oauthDomain = process.env.OAUTH_DOMAIN;
    const region = process.env.AWS_REGION || 'us-east-2';

    if (!oauthClientId || !oauthDomain) {
      return {
        statusCode: 503,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'OAuth not configured' }),
      };
    }

    // Parse client registration request (if provided)
    let clientMetadata: Record<string, unknown> = {};
    try {
      if (event.body) {
        clientMetadata = JSON.parse(event.body);
      }
    } catch {
      // Ignore parse errors - metadata is optional
    }

    console.info('DCR request received', {
      redirect_uris: clientMetadata.redirect_uris,
      client_name: clientMetadata.client_name,
    });

    // Return pre-configured Cognito client credentials
    // Per RFC 7591, we return client information that matches our Cognito app client
    const cognitoBaseUrl = `https://${oauthDomain}.auth.${region}.amazoncognito.com`;

    const clientResponse = {
      client_id: oauthClientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // No client_secret - this is a public client using PKCE
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
      client_name: clientMetadata.client_name || 'Claude MCP Client',
      scope: 'openid profile email mcp.donate-mate.com/read mcp.donate-mate.com/write',
    };

    return {
      statusCode: 201,
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(clientResponse),
    };
  }

  // Check if this is an MCP endpoint (root / or /mcp)
  const isMcpEndpoint = path === '/' || path.endsWith('/mcp');

  if (isMcpEndpoint) {
    // MCP GET endpoint - per spec, return 405 if we don't support SSE streaming
    // (We don't need server-initiated messages for this use case)
    if (method === 'GET') {
      // Check if client wants SSE (Accept: text/event-stream)
      const acceptHeader = event.headers['accept'] || '';
      if (acceptHeader.includes('text/event-stream')) {
        // Return 405 - we don't support SSE for server-initiated messages
        return {
          statusCode: 405,
          headers: { ...baseHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
          body: JSON.stringify({ error: 'Method Not Allowed', message: 'SSE not supported. Use POST for requests.' }),
        };
      }
      // Browser/info request - return server info (not part of MCP protocol, but helpful)
      return {
        statusCode: 200,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'donatemate-mcp',
          version: '0.1.0',
          protocolVersion: MCP_PROTOCOL_VERSION,
          transport: 'streamable-http',
          description: 'DonateMate MCP Server - Full Figma access via HTTP',
          auth: 'API key required: Bearer dm_xxx or ?token=dm_xxx',
        }),
      };
    }

    // MCP DELETE endpoint - session termination
    if (method === 'DELETE') {
      // We don't maintain server-side sessions (stateless), so just acknowledge
      return {
        statusCode: 202,
        headers: baseHeaders,
        body: '',
      };
    }

    // MCP POST endpoint - JSON-RPC requests
    if (method === 'POST') {
      // Extract token for authentication (API key or OAuth)
      const token = extractToken(event);
      if (!token) {
        console.warn('No authentication token provided');
        return {
          statusCode: 401,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'WWW-Authenticate': getWwwAuthenticateHeader(),
          },
          body: JSON.stringify({
            error: 'Unauthorized',
            message: 'Authentication required. Use Authorization: Bearer <token>',
          }),
        };
      }

      // Validate token based on type
      let authResult: AuthResult | null = null;
      if (token.type === 'api-key') {
        authResult = await validateApiKey(token.value);
      } else if (token.type === 'oauth') {
        authResult = await validateOAuthToken(token.value);
      }

      if (!authResult) {
        console.warn('Invalid authentication token', { type: token.type });
        return {
          statusCode: 401,
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'WWW-Authenticate': getWwwAuthenticateHeader(),
          },
          body: JSON.stringify({
            error: 'Unauthorized',
            message: 'Invalid or expired token',
          }),
        };
      }

      console.info('Authenticated request', {
        userId: authResult.userId,
        email: authResult.email,
        authMethod: authResult.authMethod,
      });

      // Track request for rate limiting (non-blocking, only for API keys)
      if (authResult.authMethod === 'api-key') {
        trackRequest(authResult.keyHash).catch(() => {});
      }

      try {
        const body = event.body ? JSON.parse(event.body) : {};
        if (body.jsonrpc !== '2.0' || !body.method) {
          return {
            statusCode: 400,
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'Invalid Request' } }),
          };
        }

        const response = await processMessage(body as McpRequest);

        // Response headers - include session ID for initialize responses
        const responseHeaders: Record<string, string> = { ...baseHeaders, 'Content-Type': 'application/json' };

        // If this is an initialize response, include session ID per MCP spec
        if (body.method === 'initialize' && response.result) {
          responseHeaders['Mcp-Session-Id'] = generateSessionId();
        }

        return {
          statusCode: 200,
          headers: responseHeaders,
          body: JSON.stringify(response),
        };
      } catch (error) {
        console.error('Request processing error', { error });
        return {
          statusCode: 500,
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }),
        };
      }
    }
  }

  return {
    statusCode: 404,
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Not found' }),
  };
}
