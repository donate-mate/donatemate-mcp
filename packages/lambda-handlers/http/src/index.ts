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
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Anthropic from '@anthropic-ai/sdk';
import { createHash, createVerify, createSign } from 'crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const ssmClient = new SSMClient({});
const lambdaClient = new LambdaClient({});
const secretsClient = new SecretsManagerClient({});

// ============================================================================
// Confluence Integration
// ============================================================================

interface ConfluenceCredentials {
  email: string;
  token: string;
  host: string;
}

let confluenceCreds: ConfluenceCredentials | null = null;

async function getConfluenceCredentials(): Promise<ConfluenceCredentials> {
  if (confluenceCreds) return confluenceCreds;

  const secretName = `/donatemate/${process.env.ENVIRONMENT || 'staging'}/knowledge/confluence`;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  confluenceCreds = JSON.parse(response.SecretString || '{}');
  return confluenceCreds!;
}

async function confluenceRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const creds = await getConfluenceCredentials();
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  const response = await fetch(`${creds.host}/wiki/rest/api${endpoint}`, {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Confluence API ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Jira Integration
// ============================================================================

interface JiraCredentials {
  email: string;
  token: string;
  host: string;
}

let jiraCreds: JiraCredentials | null = null;

async function getJiraCredentials(): Promise<JiraCredentials> {
  if (jiraCreds) return jiraCreds;

  const secretName = `/donatemate/${process.env.ENVIRONMENT || 'staging'}/knowledge/jira`;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  jiraCreds = JSON.parse(response.SecretString || '{}');
  return jiraCreds!;
}

async function jiraRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const creds = await getJiraCredentials();
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  const response = await fetch(`${creds.host}/rest/api/3${endpoint}`, {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira API ${response.status}: ${errorText}`);
  }

  // Some endpoints (e.g., issue transitions execute) return 204 No Content
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Jira Agile (Software) API lives under /rest/agile/1.0 — sprints, boards, backlog.
async function jiraAgileRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const creds = await getJiraCredentials();
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  const response = await fetch(`${creds.host}/rest/agile/1.0${endpoint}`, {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira Agile API ${response.status}: ${errorText}`);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Convert plain text to a minimal ADF document, or pass through if already ADF.
function toAdf(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const paragraphs = input.split(/\n\n+/).map((para) => ({
    type: 'paragraph',
    content: para
      .split(/\n/)
      .flatMap((line, i, arr) => {
        const nodes: unknown[] = [{ type: 'text', text: line }];
        if (i < arr.length - 1) nodes.push({ type: 'hardBreak' });
        return nodes;
      }),
  }));
  return { version: 1, type: 'doc', content: paragraphs };
}

// Pull readable text out of an ADF document so we can return a short preview.
function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  const children = Array.isArray(node.content) ? node.content : [];
  const sep = node.type === 'paragraph' || node.type === 'heading' ? '\n' : '';
  return children.map(adfToPlainText).join('') + sep;
}

function summarizeJiraIssue(issue: any, host: string) {
  return {
    key: issue.key,
    id: issue.id,
    summary: issue.fields?.summary,
    status: issue.fields?.status?.name,
    issueType: issue.fields?.issuetype?.name,
    priority: issue.fields?.priority?.name,
    assignee: issue.fields?.assignee
      ? { accountId: issue.fields.assignee.accountId, displayName: issue.fields.assignee.displayName }
      : null,
    reporter: issue.fields?.reporter
      ? { accountId: issue.fields.reporter.accountId, displayName: issue.fields.reporter.displayName }
      : null,
    labels: issue.fields?.labels,
    updated: issue.fields?.updated,
    url: `${host}/browse/${issue.key}`,
  };
}

// ============================================================================
// Anthropic (Claude) — powers AI enhancement tools (e.g. dm_jira_enhance)
// ============================================================================

const ENHANCE_MODEL = process.env.ENHANCE_MODEL || 'claude-opus-4-7';
let anthropicClient: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;

  const secretName = `donatemate/${process.env.ENVIRONMENT || 'staging'}/anthropic-api-key`;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  const apiKey = (response.SecretString || '').trim();
  if (!apiKey) {
    throw new Error('Anthropic API key not configured in Secrets Manager');
  }
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

const JIRA_ENHANCE_SYSTEM = `You are a senior product engineer who rewrites Jira issues so an engineer can pick them up with zero back-and-forth.

Output GitHub-flavored markdown only — no preamble, no "here is", no closing remarks. Be specific and concise; do not invent product facts, ticket IDs, or APIs that are not present in the input. When a detail is genuinely unknown, add a short "Open questions" list rather than guessing.

Modes:
- "full": produce the complete rewritten issue with these sections in order — a one-line **Summary**, **Problem / Context**, **Proposed approach** (only if the input implies one; otherwise omit), **Acceptance criteria** as a checkbox list of independently verifiable conditions, **Edge cases**, and **Open questions** (only if any exist).
- "description": improve only the description prose — clearer, structured, no fluff. Do not add acceptance criteria.
- "acceptance_criteria": output only an **Acceptance criteria** checkbox list of independently verifiable conditions.`;

// Extract concatenated text from a Claude message's content blocks.
function claudeText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ============================================================================
// Google Analytics Integration
// ============================================================================

interface GAServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

let gaServiceAccount: GAServiceAccount | null = null;
let gaAccessToken: string | null = null;
let gaTokenExpiry = 0;
const GA_PROPERTY_ID = '508200919';

async function getGAServiceAccount(): Promise<GAServiceAccount> {
  if (gaServiceAccount) return gaServiceAccount;

  const secretName = `/donatemate/${process.env.ENVIRONMENT || 'staging'}/google/analytics-service-account`;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  gaServiceAccount = JSON.parse(response.SecretString || '{}');
  return gaServiceAccount!;
}

// All Google API scopes we need
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.manage.users',
  'https://www.googleapis.com/auth/adwords',
].join(' ');

function createJWT(serviceAccount: GAServiceAccount, scopes: string = GOOGLE_SCOPES): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes,
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${base64Header}.${base64Payload}`;

  const sign = createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');

  return `${signatureInput}.${signature}`;
}

async function getGAAccessToken(): Promise<string> {
  if (gaAccessToken && Date.now() < gaTokenExpiry) {
    return gaAccessToken;
  }

  const serviceAccount = await getGAServiceAccount();
  const jwt = createJWT(serviceAccount);

  const response = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get GA access token: ${error}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  gaAccessToken = data.access_token;
  gaTokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 60s early

  return gaAccessToken;
}

async function gaDataApiRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  const token = await getGAAccessToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/${endpoint}`;

  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GA Data API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

interface GAReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: unknown;
  orderBys?: Array<{ dimension?: { dimensionName: string }; metric?: { metricName: string }; desc?: boolean }>;
  limit?: number;
}

async function runGAReport(request: GAReportRequest): Promise<unknown> {
  return gaDataApiRequest(`properties/${GA_PROPERTY_ID}:runReport`, request);
}

async function runGARealtimeReport(request: { dimensions?: Array<{ name: string }>; metrics: Array<{ name: string }> }): Promise<unknown> {
  return gaDataApiRequest(`properties/${GA_PROPERTY_ID}:runRealtimeReport`, request);
}

// ============================================================================
// Google Analytics Admin API
// ============================================================================

async function gaAdminApiRequest<T>(endpoint: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  const token = await getGAAccessToken();
  const url = `https://analyticsadmin.googleapis.com/v1alpha/${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GA Admin API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

async function listGAAccounts(): Promise<unknown> {
  return gaAdminApiRequest('accounts');
}

async function listGAProperties(accountId?: string): Promise<unknown> {
  const filter = accountId ? `?filter=parent:accounts/${accountId}` : '';
  return gaAdminApiRequest(`properties${filter}`);
}

async function getGAProperty(propertyId: string = GA_PROPERTY_ID): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}`);
}

async function listGAAudiences(propertyId: string = GA_PROPERTY_ID): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/audiences`);
}

async function createGAAudience(propertyId: string = GA_PROPERTY_ID, audience: unknown): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/audiences`, 'POST', audience);
}

async function listGACustomDimensions(propertyId: string = GA_PROPERTY_ID): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/customDimensions`);
}

async function createGACustomDimension(propertyId: string = GA_PROPERTY_ID, dimension: unknown): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/customDimensions`, 'POST', dimension);
}

async function listGAConversionEvents(propertyId: string = GA_PROPERTY_ID): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/conversionEvents`);
}

async function createGAConversionEvent(propertyId: string = GA_PROPERTY_ID, eventName: string): Promise<unknown> {
  return gaAdminApiRequest(`properties/${propertyId}/conversionEvents`, 'POST', { eventName });
}

// ============================================================================
// Google Ads API (Read + Management, NO budget changes)
// ============================================================================

interface GoogleAdsConfig {
  developerToken: string;
  customerId: string;
  loginCustomerId?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

let googleAdsConfig: GoogleAdsConfig | null = null;
let googleAdsAccessToken: string | null = null;
let googleAdsTokenExpiry: number = 0;

async function getGoogleAdsConfig(): Promise<GoogleAdsConfig> {
  if (googleAdsConfig) return googleAdsConfig;

  const secretName = `/donatemate/${process.env.ENVIRONMENT || 'staging'}/google/ads-config`;
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    googleAdsConfig = JSON.parse(response.SecretString || '{}');
    return googleAdsConfig!;
  } catch (error) {
    throw new Error('Google Ads not configured. Add developer token and customer ID to Secrets Manager.');
  }
}

// Get Google Ads access token using OAuth refresh token
async function getGoogleAdsAccessToken(): Promise<string> {
  const now = Date.now();
  if (googleAdsAccessToken && now < googleAdsTokenExpiry - 60000) {
    return googleAdsAccessToken;
  }

  const adsConfig = await getGoogleAdsConfig();

  if (!adsConfig.refreshToken || !adsConfig.clientId || !adsConfig.clientSecret) {
    throw new Error('Google Ads OAuth not configured. Missing refreshToken, clientId, or clientSecret.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: adsConfig.clientId,
      client_secret: adsConfig.clientSecret,
      refresh_token: adsConfig.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh Google Ads token: ${error}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  googleAdsAccessToken = data.access_token;
  googleAdsTokenExpiry = now + data.expires_in * 1000;
  return googleAdsAccessToken;
}

async function googleAdsApiRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown
): Promise<T> {
  const token = await getGoogleAdsAccessToken();
  const adsConfig = await getGoogleAdsConfig();

  const customerId = adsConfig.customerId.replace(/-/g, '');
  const url = `https://googleads.googleapis.com/v21/customers/${customerId}/${endpoint}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'developer-token': adsConfig.developerToken,
  };

  if (adsConfig.loginCustomerId) {
    headers['login-customer-id'] = adsConfig.loginCustomerId.replace(/-/g, '');
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Ads API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<T>;
}

// Google Ads Search API (using GAQL)
async function searchGoogleAds(query: string): Promise<unknown> {
  const adsConfig = await getGoogleAdsConfig();
  const customerId = adsConfig.customerId.replace(/-/g, '');

  return googleAdsApiRequest(`googleAds:search`, 'POST', {
    query,
    customerId,
  });
}

// Google Ads Mutate API - for creating, updating, removing resources
async function mutateGoogleAds(
  resourceType: string,
  operations: Array<{ create?: unknown; update?: unknown; remove?: string; updateMask?: string }>
): Promise<unknown> {
  const adsConfig = await getGoogleAdsConfig();
  const customerId = adsConfig.customerId.replace(/-/g, '');

  // Map resource types to their mutate endpoints
  const endpointMap: Record<string, string> = {
    'campaign': 'campaigns:mutate',
    'ad_group': 'adGroups:mutate',
    'ad_group_ad': 'adGroupAds:mutate',
    'ad_group_criterion': 'adGroupCriteria:mutate',
    'campaign_criterion': 'campaignCriteria:mutate',
    'asset': 'assets:mutate',
    'asset_group': 'assetGroups:mutate',
    'asset_group_asset': 'assetGroupAssets:mutate',
  };

  const endpoint = endpointMap[resourceType];
  if (!endpoint) {
    throw new Error(`Unknown resource type: ${resourceType}`);
  }

  return googleAdsApiRequest(endpoint, 'POST', {
    customerId,
    operations,
  });
}

// Helper to create an asset and return its resource name
async function createAsset(assetData: { textAsset?: { text: string }; imageAsset?: { data: string }; youtubeVideoAsset?: { youtubeVideoId: string } }): Promise<string> {
  const result = await mutateGoogleAds('asset', [{ create: assetData }]) as { results: Array<{ resourceName: string }> };
  return result.results[0].resourceName;
}

// Google Ads budget safety cap: $250/day maximum
const MAX_DAILY_BUDGET_MICROS = 250_000_000; // $250.00 in micros

const BUDGET_FIELDS = [
  'amountMicros', 'amount_micros',
  'cpcBidMicros', 'cpc_bid_micros',
  'cpmBidMicros', 'cpm_bid_micros',
  'targetCpaMicros', 'target_cpa_micros',
];

function extractMicrosValues(obj: unknown): number[] {
  if (!obj || typeof obj !== 'object') return [];
  const values: number[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    for (const [key, val] of Object.entries(o as Record<string, unknown>)) {
      if (BUDGET_FIELDS.some(f => key.toLowerCase() === f.toLowerCase()) && typeof val === 'number') {
        values.push(val);
      } else if (typeof val === 'string' && BUDGET_FIELDS.some(f => key.toLowerCase() === f.toLowerCase())) {
        values.push(parseInt(val, 10));
      } else if (typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(obj);
  return values;
}

function validateBudgetCap(obj: unknown): string | null {
  const values = extractMicrosValues(obj);
  for (const v of values) {
    if (isNaN(v) || v < 0) return 'Invalid budget/bid value: must be a positive number.';
    if (v > MAX_DAILY_BUDGET_MICROS) {
      return `Budget/bid value $${(v / 1_000_000).toFixed(2)} exceeds the $${(MAX_DAILY_BUDGET_MICROS / 1_000_000).toFixed(0)}/day safety cap. Reduce the amount or use Google Ads UI.`;
    }
  }
  return null;
}

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

// Timeout configuration by tool type (in milliseconds)
const TOOL_TIMEOUTS: Record<string, number> = {
  // Quick read-only operations
  dm_figma_get_document_info: 10000,
  dm_figma_get_selection: 10000,
  dm_figma_get_page: 10000,
  dm_figma_get_children: 15000,
  dm_figma_get_local_styles: 15000,
  dm_figma_get_variables: 15000,
  dm_figma_current_file: 10000,
  // Operations that may scan more nodes
  dm_figma_get_all_nodes: 20000,
  dm_figma_get_file_context: 20000,
  dm_figma_validate_design: 25000,
  dm_figma_query: 20000, // Queries may traverse document
  // Mutating operations (may need more time for Figma to process)
  dm_figma_create_frame: 15000,
  dm_figma_create_text: 15000,
  dm_figma_create_rectangle: 15000,
  dm_figma_update_node: 15000,
  dm_figma_delete_node: 15000,
  dm_figma_clone_node: 20000,
  dm_figma_move_node: 20000,
  dm_figma_export_node: 30000, // Exports may be slow
  dm_figma_review: 30000, // Exports + metadata
  dm_figma_execute: 45000, // Arbitrary code may take time
  // File management (may need to wait for Figma to open)
  dm_figma_open_file: 45000, // Opening files can take time
  dm_figma_list_files: 20000, // API calls to Figma
  dm_figma_find_file: 15000, // Search cached files
};

const DEFAULT_RELAY_TIMEOUT = 25000; // 25 seconds default (was 30)
const POLL_INTERVAL_MS = 300; // Poll every 300ms (was 500ms)

async function sendToRelayAndWait(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number
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

  // Use tool-specific timeout or default
  const effectiveTimeout = timeoutMs ?? TOOL_TIMEOUTS[tool] ?? DEFAULT_RELAY_TIMEOUT;
  const requestId = `http_${++relayRequestId}_${Date.now()}`;

  console.info('[relay] sending request', { tool, requestId, timeoutMs: effectiveTimeout });

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

  try {
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
  } catch (sendError) {
    // Clean up pending request on send failure
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { connectionId: { S: `http-request:${requestId}` } },
      })
    ).catch(() => {});
    console.error('[relay] send failed', { tool, requestId, error: sendError instanceof Error ? sendError.message : 'Unknown' });
    throw new Error('Failed to send request to Figma relay - connection may be stale');
  }

  // Poll for response with adaptive backoff
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < effectiveTimeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    pollCount++;

    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { connectionId: { S: `http-request:${requestId}` } },
      })
    );

    if (result.Item?.status?.S === 'completed') {
      const duration = Date.now() - startTime;
      console.info('[relay] response received', { tool, requestId, duration, pollCount });

      // Clean up
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { connectionId: { S: `http-request:${requestId}` } },
        })
      ).catch(() => {});

      const responseData = result.Item.response?.S;
      if (responseData) {
        return JSON.parse(responseData);
      }
      throw new Error('Empty response from relay');
    }

    if (result.Item?.status?.S === 'error') {
      const duration = Date.now() - startTime;
      const errorMessage = result.Item.error?.S || 'Relay error';
      console.error('[relay] error response', { tool, requestId, duration, error: errorMessage });

      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { connectionId: { S: `http-request:${requestId}` } },
        })
      ).catch(() => {});

      throw new Error(errorMessage);
    }
  }

  // Timeout - clean up and throw
  const duration = Date.now() - startTime;
  console.error('[relay] timeout', { tool, requestId, duration, pollCount, timeoutMs: effectiveTimeout });

  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { connectionId: { S: `http-request:${requestId}` } },
    })
  ).catch(() => {});

  throw new Error(`Timeout waiting for Figma plugin response (${Math.round(effectiveTimeout / 1000)}s). Tool: ${tool}`);
}

// Plugin-based tools (routed through relay)
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
  // New advanced tools
  'dm_figma_execute',
  'dm_figma_query',
  'dm_figma_review',
  // File management tools (handled by relay, not plugin)
  'dm_figma_open_file',
  'dm_figma_list_files',
  'dm_figma_find_file',
  'dm_figma_current_file',
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
      description: 'List DonateMate design tokens. Use to find available colors, spacing, typography values.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category (e.g., "colors", "spacing")' },
        },
      },
    },
    {
      name: 'dm_tokens_get',
      description: 'Get a specific design token value by its path.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Token path (e.g., "global.colors.sky.500")' } },
        required: ['path'],
      },
    },
    {
      name: 'dm_tokens_search',
      description: 'Search design tokens by name or value. Use to find tokens matching a color or keyword.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search term (e.g., "blue", "#3D")' } },
        required: ['query'],
      },
    },
  ];

  const figmaRestTools = [
    {
      name: 'dm_figma_get_file',
      description: 'Get Figma file structure. Use to explore file contents by key.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'Figma file key (from URL)' },
          depth: { type: 'number', description: 'Tree depth (default: 2)' },
        },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_get_node',
      description: 'Get specific nodes by ID from any Figma file.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'Figma file key' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node IDs to fetch' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
    {
      name: 'dm_figma_list_branches',
      description: 'List all branches of a Figma file.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Figma file URL' } },
        required: ['url'],
      },
    },
    {
      name: 'dm_figma_create_branch',
      description: 'REQUIRED before design changes: Create a branch to work in.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Figma file URL' },
          name: { type: 'string', description: 'Branch name (e.g., "claude/add-nav-bar")' },
        },
        required: ['url', 'name'],
      },
    },
    {
      name: 'dm_figma_get_comments',
      description: 'Get comments from a Figma file.',
      inputSchema: {
        type: 'object',
        properties: { fileKey: { type: 'string', description: 'Figma file key' } },
        required: ['fileKey'],
      },
    },
    {
      name: 'dm_figma_post_comment',
      description: 'Add a comment to a Figma file or specific node.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'Figma file key' },
          message: { type: 'string', description: 'Comment text' },
          nodeId: { type: 'string', description: 'Node ID to attach comment to' },
        },
        required: ['fileKey', 'message'],
      },
    },
    {
      name: 'dm_figma_export',
      description: 'Export nodes as images (PNG, SVG, PDF, JPG).',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'Figma file key' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Nodes to export' },
          format: { type: 'string', enum: ['jpg', 'png', 'svg', 'pdf'] },
          scale: { type: 'number', description: 'Scale factor (default: 2)' },
        },
        required: ['fileKey', 'nodeIds'],
      },
    },
  ];

  // Plugin-based tools (full Figma editing via plugin relay)
  const figmaPluginTools = [
    {
      name: 'dm_figma_get_document_info',
      description: 'Get info about the currently open Figma document (name, pages, current page).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_file_context',
      description: 'CALL FIRST: Get file architecture, design patterns, and guidelines before making changes.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_selection',
      description: 'Get nodes currently selected in Figma (what the user has clicked).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_page',
      description: 'Get current page with its top-level children.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_set_page',
      description: 'Navigate to a different page in the document.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Page ID (use this OR pageName)' },
          pageName: { type: 'string', description: 'Page name to find' },
        },
      },
    },
    {
      name: 'dm_figma_get_children',
      description: 'Get child nodes of a specific node.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Parent node ID' },
          depth: { type: 'number', description: 'How deep to traverse (default: 1)' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_get_all_nodes',
      description: 'Find nodes on page by type or name. Use to locate specific elements.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', description: 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)' },
          namePattern: { type: 'string', description: 'Filter by name (substring match)' },
          limit: { type: 'number', description: 'Max results (default: 500)' },
        },
      },
    },
    {
      name: 'dm_figma_update_node',
      description: 'Modify node properties (name, position, size, fills, text). Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node to update' },
          properties: { type: 'object', description: 'Properties: x, y, width, height, name, fills, characters, etc.' },
        },
        required: ['nodeId', 'properties'],
      },
    },
    {
      name: 'dm_figma_delete_node',
      description: 'Remove a node from the document. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: { nodeId: { type: 'string', description: 'Node to delete' } },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_clone_node',
      description: 'Duplicate a node. Use parentId to clone directly INTO a target frame (efficient). Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node to clone' },
          newName: { type: 'string', description: 'Name for clone' },
          parentId: { type: 'string', description: 'Target parent - clone appears inside this frame' },
          offsetX: { type: 'number', description: 'X position' },
          offsetY: { type: 'number', description: 'Y position' },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'dm_figma_move_node',
      description: 'Move a node into a different parent frame (reparent). Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node to move' },
          parentId: { type: 'string', description: 'Target parent frame' },
          index: { type: 'number', description: 'Position in children (0 = first)' },
        },
        required: ['nodeId', 'parentId'],
      },
    },
    {
      name: 'dm_figma_create_frame',
      description: 'Create a frame (container). Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Frame name' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string', description: 'Background hex color' },
          parentId: { type: 'string', description: 'Parent frame ID' },
        },
        required: ['name', 'width', 'height'],
      },
    },
    {
      name: 'dm_figma_create_text',
      description: 'Create a text element. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          characters: { type: 'string', description: 'Text content' },
          x: { type: 'number' },
          y: { type: 'number' },
          fontSize: { type: 'number' },
          fill: { type: 'string', description: 'Text hex color' },
          parentId: { type: 'string', description: 'Parent frame ID' },
        },
        required: ['characters'],
      },
    },
    {
      name: 'dm_figma_create_rectangle',
      description: 'Create a rectangle shape. Create branch first.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string', description: 'Fill hex color' },
          cornerRadius: { type: 'number' },
          name: { type: 'string' },
          parentId: { type: 'string', description: 'Parent frame ID' },
        },
        required: ['width', 'height'],
      },
    },
    {
      name: 'dm_figma_validate_design',
      description: 'CALL AFTER CHANGES: Verify design tokens and component patterns are correct.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'Nodes to validate (or empty for current page)' },
          checkTokens: { type: 'boolean', description: 'Verify design tokens' },
          checkComponents: { type: 'boolean', description: 'Verify component usage' },
          componentPatterns: { type: 'array', items: { type: 'string' }, description: 'Expected patterns' },
        },
      },
    },
    {
      name: 'dm_figma_get_local_styles',
      description: 'Get local paint, text, and effect styles defined in the file.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_figma_get_variables',
      description: 'Get local variable collections (colors, spacing, etc.).',
      inputSchema: { type: 'object', properties: {} },
    },
    // Advanced tools for complete Figma control
    {
      name: 'dm_figma_execute',
      description: 'Execute arbitrary Figma Plugin API code. Full access to figma global. Use for complex operations.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Has access to figma, selection, currentPage. Use return to return values.',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'dm_figma_query',
      description: 'Evaluate a read-only expression against the Figma document. Use for queries and searches.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression to evaluate. E.g., "figma.currentPage.children.length"',
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'dm_figma_review',
      description: 'Export a node as PNG and get visual description. Use to see what you created and iterate.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID to export (or uses current selection)' },
          scale: { type: 'number', description: 'Export scale (default: 2)' },
        },
      },
    },
    // File management tools
    {
      name: 'dm_figma_open_file',
      description: 'Open a Figma file by key or name. The file opens in Figma Desktop on the VM.',
      inputSchema: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: 'Figma file key (from URL)' },
          fileName: { type: 'string', description: 'File name to search for (if no fileKey)' },
          waitForPlugin: { type: 'boolean', description: 'Wait for plugin to be ready (default: true)' },
        },
      },
    },
    {
      name: 'dm_figma_list_files',
      description: 'List all Figma files in DonateMate projects.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Force refresh file cache (default: false)' },
        },
      },
    },
    {
      name: 'dm_figma_find_file',
      description: 'Search for a Figma file by name (fuzzy match).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (file name)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'dm_figma_current_file',
      description: 'Get info about the currently open file in Figma Desktop.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  const knowledgeTools = [
    {
      name: 'dm_knowledge_search',
      description: 'Search DonateMate knowledge: GitHub code, Jira issues, Confluence docs, Slack threads. Use date filters for recent items.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['github', 'jira', 'confluence', 'slack'] },
            description: 'Filter by source',
          },
          project: { type: 'string', description: 'Filter by project' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
          startDate: { type: 'string', description: 'From date (ISO 8601)' },
          endDate: { type: 'string', description: 'To date (ISO 8601)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'dm_knowledge_context',
      description: 'Get comprehensive context on a topic from all DonateMate sources.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic to research' },
          depth: { type: 'string', enum: ['brief', 'detailed', 'comprehensive'] },
        },
        required: ['topic'],
      },
    },
    {
      name: 'dm_knowledge_stats',
      description: 'Get knowledge base statistics (indexed content counts).',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  // Confluence write tools
  const confluenceTools = [
    {
      name: 'dm_confluence_get_page',
      description: 'Get a Confluence page by ID, including its content and version info.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Confluence page ID' },
        },
        required: ['pageId'],
      },
    },
    {
      name: 'dm_confluence_search',
      description: 'Search Confluence pages using CQL (Confluence Query Language).',
      inputSchema: {
        type: 'object',
        properties: {
          cql: { type: 'string', description: 'CQL query (e.g., "space = DM AND title ~ meeting notes")' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['cql'],
      },
    },
    {
      name: 'dm_confluence_create_page',
      description: 'Create a new Confluence page in a space.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceKey: { type: 'string', description: 'Space key (e.g., "DM")' },
          title: { type: 'string', description: 'Page title' },
          body: { type: 'string', description: 'Page content in Confluence storage format (XHTML). Use <p>, <h1>-<h6>, <ul>/<ol>/<li>, <table>, <ac:structured-macro> etc.' },
          parentId: { type: 'string', description: 'Parent page ID (optional - creates as child page)' },
        },
        required: ['spaceKey', 'title', 'body'],
      },
    },
    {
      name: 'dm_confluence_update_page',
      description: 'Update an existing Confluence page. Fetches current version automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Page ID to update' },
          title: { type: 'string', description: 'New title (optional - keeps existing if omitted)' },
          body: { type: 'string', description: 'New content in Confluence storage format (XHTML)' },
        },
        required: ['pageId', 'body'],
      },
    },
    {
      name: 'dm_confluence_get_spaces',
      description: 'List available Confluence spaces.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default: 25)' },
        },
      },
    },
    {
      name: 'dm_confluence_get_children',
      description: 'Get child pages of a Confluence page.',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'Parent page ID' },
          limit: { type: 'number', description: 'Max results (default: 25)' },
        },
        required: ['pageId'],
      },
    },
  ];

  // Jira tools (read + write)
  const jiraTools = [
    {
      name: 'dm_jira_get_issue',
      description: 'Fetch a single Jira issue by key (e.g. "DM-39"). Returns summary, status, assignee, description, comments.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key like "DM-39" or numeric ID' },
          fields: { type: 'string', description: 'Comma-separated field list (default: summary,status,assignee,priority,issuetype,labels,description,comment,updated,reporter)' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'dm_jira_search',
      description: 'Search Jira issues with JQL. Example JQL: "project = DM AND status != Done ORDER BY updated DESC".',
      inputSchema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query string' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Fields to include (default: summary, status, assignee, priority, issuetype, updated)' },
          maxResults: { type: 'number', description: 'Max issues to return (default: 25, hard cap 100)' },
          nextPageToken: { type: 'string', description: 'Pagination cursor returned by a previous call' },
        },
        required: ['jql'],
      },
    },
    {
      name: 'dm_jira_create_issue',
      description: 'Create a new Jira issue. Description may be plain text (auto-wrapped to ADF) or an ADF object.',
      inputSchema: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Project key, e.g. "DM"' },
          summary: { type: 'string', description: 'Short issue title' },
          issueType: { type: 'string', description: 'Issue type name, e.g. "Task", "Bug", "Story" (default: "Task")' },
          description: { description: 'Issue description (string or ADF object)' },
          assigneeAccountId: { type: 'string', description: 'Optional accountId to assign on creation' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
          priority: { type: 'string', description: 'Optional priority name, e.g. "Medium"' },
          parentKey: { type: 'string', description: 'Parent issue key (for subtasks / epic children)' },
        },
        required: ['projectKey', 'summary'],
      },
    },
    {
      name: 'dm_jira_update_issue',
      description: 'Update fields on an existing Jira issue. Pass only the fields you want to change.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. "DM-39"' },
          summary: { type: 'string', description: 'New summary' },
          description: { description: 'New description (string or ADF object)' },
          assigneeAccountId: { type: 'string', description: 'New assignee accountId. Use empty string "" to unassign.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Replaces the labels array entirely' },
          priority: { type: 'string', description: 'Priority name, e.g. "High"' },
          fields: { type: 'object', description: 'Escape hatch: raw fields object merged into the request (for custom fields, etc.)' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'dm_jira_add_comment',
      description: 'Add a comment to an issue. Body may be plain text (auto-wrapped to ADF) or an ADF object.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. "DM-39"' },
          body: { description: 'Comment body — plain text or ADF object' },
        },
        required: ['issueKey', 'body'],
      },
    },
    {
      name: 'dm_jira_list_transitions',
      description: 'List the workflow transitions currently available on an issue. Use this to find the transitionId before calling dm_jira_transition_issue.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. "DM-39"' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'dm_jira_transition_issue',
      description: 'Move an issue through a workflow transition (e.g., "In Progress" → "Done"). Provide transitionId from dm_jira_list_transitions, or transitionName for a case-insensitive match.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key, e.g. "DM-39"' },
          transitionId: { type: 'string', description: 'Numeric transition ID' },
          transitionName: { type: 'string', description: 'Transition display name (resolved against current available transitions)' },
          comment: { description: 'Optional comment to add with the transition (string or ADF)' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'dm_jira_enhance',
      description: 'Use Claude to rewrite/enhance a Jira issue (clearer description, acceptance criteria, edge cases). Returns the enhanced markdown; optionally writes it back to the issue description. Read-only unless apply=true.',
      inputSchema: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Issue key to enhance, e.g. "DM-39"' },
          mode: { type: 'string', enum: ['full', 'description', 'acceptance_criteria'], description: 'What to produce (default: "full")' },
          instructions: { type: 'string', description: 'Optional extra guidance for the rewrite (e.g. "focus on the mobile flow", "keep it under 150 words")' },
          apply: { type: 'boolean', description: 'If true, overwrite the issue description with the enhanced text. Default false (preview only).' },
        },
        required: ['issueKey'],
      },
    },
    {
      name: 'dm_jira_get_sprints',
      description: 'List sprints on a Jira board (Agile API). Returns sprint id, name, state, and dates. If boardId is omitted, resolves the first board for projectKey (default "DM").',
      inputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'number', description: 'Board ID. If omitted, resolved from projectKey.' },
          projectKey: { type: 'string', description: 'Project key used to resolve a board when boardId is omitted (default: "DM")' },
          state: { type: 'string', description: 'Comma-separated sprint states: active, future, closed (default: "active,future")' },
        },
      },
    },
    {
      name: 'dm_jira_add_issues_to_sprint',
      description: 'Move issues into a sprint (Agile API). Up to 50 issues per call.',
      inputSchema: {
        type: 'object',
        properties: {
          sprintId: { type: 'number', description: 'Target sprint ID (from dm_jira_get_sprints)' },
          issueKeys: { type: 'array', items: { type: 'string' }, description: 'Issue keys to move into the sprint, e.g. ["DM-39","DM-50"]' },
        },
        required: ['sprintId', 'issueKeys'],
      },
    },
  ];

  // Google Analytics tools
  const gaTools = [
    {
      name: 'dm_ga_report',
      description: 'Run a Google Analytics 4 report. Get metrics like sessions, users, pageviews with dimensions like date, page, source.',
      inputSchema: {
        type: 'object',
        properties: {
          metrics: {
            type: 'array',
            items: { type: 'string' },
            description: 'Metrics to retrieve (e.g., "sessions", "activeUsers", "screenPageViews", "eventCount", "conversions")',
          },
          dimensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Dimensions to group by (e.g., "date", "pagePath", "sessionSource", "country", "deviceCategory")',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD or "7daysAgo", "30daysAgo", "yesterday", "today")' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD or "today", "yesterday")' },
          limit: { type: 'number', description: 'Max rows to return (default: 100)' },
          orderBy: { type: 'string', description: 'Metric or dimension to sort by' },
          descending: { type: 'boolean', description: 'Sort descending (default: true)' },
        },
        required: ['metrics'],
      },
    },
    {
      name: 'dm_ga_realtime',
      description: 'Get real-time Google Analytics data: active users, current pages, traffic sources.',
      inputSchema: {
        type: 'object',
        properties: {
          metrics: {
            type: 'array',
            items: { type: 'string' },
            description: 'Real-time metrics (e.g., "activeUsers", "screenPageViews", "eventCount")',
          },
          dimensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Real-time dimensions (e.g., "unifiedScreenName", "country", "deviceCategory")',
          },
        },
      },
    },
    {
      name: 'dm_ga_summary',
      description: 'Get a quick summary of DonateMate analytics: traffic, top pages, sources, and conversions for a time period.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', '7days', '30days', '90days'],
            description: 'Time period (default: 7days)',
          },
        },
      },
    },
  ];

  // GA Admin tools
  const gaAdminTools = [
    {
      name: 'dm_ga_admin_accounts',
      description: 'List all Google Analytics accounts the service account has access to.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'dm_ga_admin_properties',
      description: 'List GA4 properties. Optionally filter by account.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Filter by account ID (optional)' },
        },
      },
    },
    {
      name: 'dm_ga_admin_audiences',
      description: 'List or create GA4 audiences for targeting and analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create'], description: 'Action to perform (default: list)' },
          audience: { type: 'object', description: 'Audience definition (for create)' },
        },
      },
    },
    {
      name: 'dm_ga_admin_custom_dimensions',
      description: 'List or create custom dimensions in GA4.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create'], description: 'Action to perform (default: list)' },
          dimension: { type: 'object', description: 'Dimension definition (for create)' },
        },
      },
    },
    {
      name: 'dm_ga_admin_conversions',
      description: 'List or create conversion events in GA4.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create'], description: 'Action to perform (default: list)' },
          eventName: { type: 'string', description: 'Event name to mark as conversion (for create)' },
        },
      },
    },
  ];

  // Google Ads tools (read + management, budget capped at $250/day)
  const googleAdsTools = [
    {
      name: 'dm_ads_query',
      description: 'Query Google Ads data using GAQL (Google Ads Query Language). Read campaigns, ad groups, ads, keywords, and performance metrics. Can also query budget and bidding data.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'GAQL query (e.g., "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'dm_ads_campaigns',
      description: 'List Google Ads campaigns with performance metrics.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ENABLED', 'PAUSED', 'REMOVED', 'ALL'], description: 'Filter by status (default: ALL)' },
          dateRange: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'THIS_MONTH'], description: 'Date range (default: LAST_30_DAYS)' },
        },
      },
    },
    {
      name: 'dm_ads_ad_groups',
      description: 'List ad groups with performance metrics.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'Filter by campaign ID (optional)' },
          dateRange: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'THIS_MONTH'], description: 'Date range (default: LAST_30_DAYS)' },
        },
      },
    },
    {
      name: 'dm_ads_keywords',
      description: 'List keywords with performance metrics and quality scores.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'Filter by campaign ID (optional)' },
          adGroupId: { type: 'string', description: 'Filter by ad group ID (optional)' },
          dateRange: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'THIS_MONTH'], description: 'Date range (default: LAST_30_DAYS)' },
        },
      },
    },
    {
      name: 'dm_ads_manage',
      description: 'Manage Google Ads campaigns, ad groups, and ads (pause/enable/remove). Budget changes are capped at $250/day.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause_campaign', 'enable_campaign', 'remove_campaign', 'pause_ad_group', 'enable_ad_group', 'remove_ad_group', 'pause_ad', 'enable_ad', 'remove_ad'], description: 'Action to perform' },
          resourceId: { type: 'string', description: 'Campaign, ad group, or ad resource ID' },
        },
        required: ['action', 'resourceId'],
      },
    },
    {
      name: 'dm_ads_asset_groups',
      description: 'List asset groups for Performance Max campaigns.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'Filter by campaign ID (optional)' },
        },
      },
    },
    {
      name: 'dm_ads_asset_group_assets',
      description: 'List assets within an asset group (headlines, descriptions, images, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          assetGroupId: { type: 'string', description: 'Asset group ID (required)' },
        },
        required: ['assetGroupId'],
      },
    },
    {
      name: 'dm_ads_mutate',
      description: 'Create, update, or remove Google Ads resources. Full ad management including budgets and bids (capped at $250/day). Supports: campaigns, ad_groups, ads, asset_groups, asset_group_assets, keywords, audience targeting, campaign_budgets, bidding_strategies.',
      inputSchema: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: 'Array of mutate operations',
            items: {
              type: 'object',
              properties: {
                resourceType: { type: 'string', enum: ['campaign', 'ad_group', 'ad_group_ad', 'asset_group', 'asset_group_asset', 'ad_group_criterion', 'campaign_criterion'], description: 'Type of resource to mutate' },
                operation: { type: 'string', enum: ['create', 'update', 'remove'], description: 'Operation type' },
                resource: { type: 'object', description: 'Resource data for create/update operations' },
                resourceName: { type: 'string', description: 'Resource name for update/remove operations' },
                updateMask: { type: 'string', description: 'Fields to update (comma-separated) for update operations' },
              },
              required: ['resourceType', 'operation'],
            },
          },
        },
        required: ['operations'],
      },
    },
    {
      name: 'dm_ads_create_responsive_search_ad',
      description: 'Create a responsive search ad with headlines and descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          adGroupId: { type: 'string', description: 'Ad group ID to add the ad to' },
          headlines: { type: 'array', items: { type: 'string' }, description: 'Array of headlines (3-15 required, max 30 chars each)' },
          descriptions: { type: 'array', items: { type: 'string' }, description: 'Array of descriptions (2-4 required, max 90 chars each)' },
          finalUrls: { type: 'array', items: { type: 'string' }, description: 'Landing page URLs' },
          path1: { type: 'string', description: 'Display URL path 1 (optional, max 15 chars)' },
          path2: { type: 'string', description: 'Display URL path 2 (optional, max 15 chars)' },
        },
        required: ['adGroupId', 'headlines', 'descriptions', 'finalUrls'],
      },
    },
    {
      name: 'dm_ads_add_keywords',
      description: 'Add keywords to an ad group.',
      inputSchema: {
        type: 'object',
        properties: {
          adGroupId: { type: 'string', description: 'Ad group ID' },
          keywords: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Keyword text' },
                matchType: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'], description: 'Match type' },
              },
              required: ['text', 'matchType'],
            },
            description: 'Array of keywords to add',
          },
        },
        required: ['adGroupId', 'keywords'],
      },
    },
    {
      name: 'dm_ads_update_asset_group',
      description: 'Update an asset group (name, status, final URLs, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          assetGroupId: { type: 'string', description: 'Asset group ID' },
          name: { type: 'string', description: 'New name (optional)' },
          status: { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'New status (optional)' },
          finalUrls: { type: 'array', items: { type: 'string' }, description: 'Final URLs (optional)' },
          path1: { type: 'string', description: 'Display path 1 (optional)' },
          path2: { type: 'string', description: 'Display path 2 (optional)' },
        },
        required: ['assetGroupId'],
      },
    },
    {
      name: 'dm_ads_add_asset_to_group',
      description: 'Add an asset (headline, description, image, etc.) to an asset group.',
      inputSchema: {
        type: 'object',
        properties: {
          assetGroupId: { type: 'string', description: 'Asset group ID' },
          assetType: { type: 'string', enum: ['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO', 'YOUTUBE_VIDEO', 'CALL_TO_ACTION_SELECTION'], description: 'Type of asset' },
          textContent: { type: 'string', description: 'Text content for text assets (headlines, descriptions)' },
          imageUrl: { type: 'string', description: 'Image URL for image assets' },
          youtubeVideoId: { type: 'string', description: 'YouTube video ID for video assets' },
        },
        required: ['assetGroupId', 'assetType'],
      },
    },
    {
      name: 'dm_ads_remove_asset_from_group',
      description: 'Remove an asset from an asset group.',
      inputSchema: {
        type: 'object',
        properties: {
          assetGroupAssetResourceName: { type: 'string', description: 'Full resource name of the asset group asset link' },
        },
        required: ['assetGroupAssetResourceName'],
      },
    },
  ];

  return { tools: [...tokenTools, ...figmaRestTools, ...figmaPluginTools, ...knowledgeTools, ...confluenceTools, ...jiraTools, ...gaTools, ...gaAdminTools, ...googleAdsTools] };
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
  const startTime = Date.now();

  // Log tool invocation start
  console.info('[tool] invocation start', {
    tool: name,
    isPluginTool: PLUGIN_TOOLS.has(name),
    argsKeys: args ? Object.keys(args) : [],
  });

  // Plugin-based tools - route through relay
  if (PLUGIN_TOOLS.has(name)) {
    try {
      const result = await sendToRelayAndWait(name, args || {});
      const duration = Date.now() - startTime;
      console.info('[tool] invocation complete', { tool: name, duration, success: true });
      // Use compact JSON to reduce response size and context window usage
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[tool] invocation failed', { tool: name, duration, error: errorMessage });
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }],
        isError: true,
      };
    }
  }

  // REST API and token tools - wrap in try/catch for logging
  try {
    let result: unknown;
    switch (name) {
      case 'dm_tokens_list': {
        const category = (args?.category as string) || '';
        const flatTokens = flattenTokens(designTokens).filter(t => !category || t.path.startsWith(category));
        result = { content: [{ type: 'text', text: JSON.stringify({ count: flatTokens.length, tokens: flatTokens }, null, 2) }] };
        break;
      }

    case 'dm_tokens_search': {
      const query = ((args?.query as string) || '').toLowerCase();
      const flatTokens = flattenTokens(designTokens).filter(
        t => t.path.toLowerCase().includes(query) || String(t.value).toLowerCase().includes(query)
      );
      result = { content: [{ type: 'text', text: JSON.stringify({ query, count: flatTokens.length, tokens: flatTokens }, null, 2) }] };
      break;
    }

    case 'dm_tokens_get': {
      const path = args?.path as string;
      const flatTokens = flattenTokens(designTokens);
      const token = flatTokens.find(t => t.path === path);
      if (!token) {
        const duration = Date.now() - startTime;
        console.warn('[tool] invocation error', { tool: name, duration, error: `Token not found: ${path}` });
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Token not found: ${path}` }) }], isError: true };
      }
      result = { content: [{ type: 'text', text: JSON.stringify(token, null, 2) }] };
      break;
    }

    case 'dm_figma_get_file': {
      const fileKey = args?.fileKey as string;
      const depth = (args?.depth as number) || 2;
      const file = await figmaRequest<any>(`/files/${fileKey}?depth=${depth}`);
      result = { content: [{ type: 'text', text: JSON.stringify({ name: file.name, lastModified: file.lastModified, document: file.document }, null, 2) }] };
      break;
    }

    case 'dm_figma_get_node': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const data = await figmaRequest<any>(`/files/${fileKey}/nodes?ids=${nodeIds.join(',')}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      break;
    }

    case 'dm_figma_list_branches': {
      const url = args?.url as string;
      const { fileKey } = parseFigmaUrl(url);
      const data = await figmaRequest<any>(`/files/${fileKey}/branches`);
      result = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            fileKey,
            count: data.branches?.length || 0,
            branches: (data.branches || []).map((b: any) => ({ ...b, branchUrl: `https://www.figma.com/file/${b.key}` })),
          }, null, 2),
        }],
      };
      break;
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
      result = {
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
      break;
    }

    case 'dm_figma_get_comments': {
      const fileKey = args?.fileKey as string;
      const data = await figmaRequest<any>(`/files/${fileKey}/comments`);
      result = { content: [{ type: 'text', text: JSON.stringify({ count: data.comments.length, comments: data.comments }, null, 2) }] };
      break;
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
      result = { content: [{ type: 'text', text: JSON.stringify({ success: true, comment }, null, 2) }] };
      break;
    }

    case 'dm_figma_export': {
      const fileKey = args?.fileKey as string;
      const nodeIds = args?.nodeIds as string[];
      const format = (args?.format as string) || 'png';
      const scale = (args?.scale as number) || 2;
      const data = await figmaRequest<any>(`/images/${fileKey}?ids=${nodeIds.join(',')}&format=${format}&scale=${scale}`);
      result = { content: [{ type: 'text', text: JSON.stringify({ format, scale, images: data.images }, null, 2) }] };
      break;
    }

    // Knowledge base tools
    case 'dm_knowledge_search':
    case 'dm_knowledge_context':
    case 'dm_knowledge_stats': {
      const knowledgeResult = await invokeKnowledgeSearch(name, args || {});
      result = { content: [{ type: 'text', text: JSON.stringify(knowledgeResult, null, 2) }] };
      break;
    }

    // Confluence tools
    case 'dm_confluence_get_page': {
      const pageId = args?.pageId as string;
      const page = await confluenceRequest<any>('GET', `/content/${pageId}?expand=body.storage,version,space,ancestors`);
      result = { content: [{ type: 'text', text: JSON.stringify({
        id: page.id,
        title: page.title,
        spaceKey: page.space?.key,
        version: page.version?.number,
        body: page.body?.storage?.value,
        url: page._links?.base + page._links?.webui,
        ancestors: page.ancestors?.map((a: any) => ({ id: a.id, title: a.title })),
      }, null, 2) }] };
      break;
    }

    case 'dm_confluence_search': {
      const cql = args?.cql as string;
      const limit = Math.min((args?.limit as number) || 10, 50);
      const searchResult = await confluenceRequest<any>('GET', `/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,version`);
      const creds = await getConfluenceCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        totalSize: searchResult.totalSize,
        results: searchResult.results?.map((r: any) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          spaceKey: r.space?.key,
          version: r.version?.number,
          url: `${creds.host}/wiki${r._links?.webui}`,
        })),
      }, null, 2) }] };
      break;
    }

    case 'dm_confluence_create_page': {
      const spaceKey = args?.spaceKey as string;
      const title = args?.title as string;
      const body = args?.body as string;
      const parentId = args?.parentId as string | undefined;

      const createPayload: any = {
        type: 'page',
        title,
        space: { key: spaceKey },
        body: {
          storage: {
            value: body,
            representation: 'storage',
          },
        },
      };

      if (parentId) {
        createPayload.ancestors = [{ id: parentId }];
      }

      const created = await confluenceRequest<any>('POST', '/content', createPayload);
      const creds = await getConfluenceCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        id: created.id,
        title: created.title,
        version: created.version?.number,
        url: `${creds.host}/wiki${created._links?.webui}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_confluence_update_page': {
      const pageId = args?.pageId as string;
      const newBody = args?.body as string;
      const newTitle = args?.title as string | undefined;

      // Fetch current version
      const current = await confluenceRequest<any>('GET', `/content/${pageId}?expand=version,space`);
      const currentVersion = current.version?.number || 1;

      const updatePayload = {
        type: 'page',
        title: newTitle || current.title,
        version: { number: currentVersion + 1 },
        body: {
          storage: {
            value: newBody,
            representation: 'storage',
          },
        },
      };

      const updated = await confluenceRequest<any>('PUT', `/content/${pageId}`, updatePayload);
      const creds = await getConfluenceCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        id: updated.id,
        title: updated.title,
        version: updated.version?.number,
        url: `${creds.host}/wiki${updated._links?.webui}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_confluence_get_spaces': {
      const limit = Math.min((args?.limit as number) || 25, 100);
      const spacesResult = await confluenceRequest<any>('GET', `/space?limit=${limit}`);
      const creds = await getConfluenceCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        results: spacesResult.results?.map((s: any) => ({
          key: s.key,
          name: s.name,
          type: s.type,
          url: `${creds.host}/wiki${s._links?.webui}`,
        })),
      }, null, 2) }] };
      break;
    }

    case 'dm_confluence_get_children': {
      const pageId = args?.pageId as string;
      const limit = Math.min((args?.limit as number) || 25, 100);
      const children = await confluenceRequest<any>('GET', `/content/${pageId}/child/page?limit=${limit}&expand=version`);
      result = { content: [{ type: 'text', text: JSON.stringify({
        results: children.results?.map((c: any) => ({
          id: c.id,
          title: c.title,
          version: c.version?.number,
        })),
      }, null, 2) }] };
      break;
    }

    // Jira tools
    case 'dm_jira_get_issue': {
      const issueKey = args?.issueKey as string;
      const fields = (args?.fields as string) || 'summary,status,assignee,priority,issuetype,labels,description,comment,updated,reporter';
      const issue = await jiraRequest<any>('GET', `/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`);
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        ...summarizeJiraIssue(issue, creds.host),
        description: issue.fields?.description ? adfToPlainText(issue.fields.description).trim() : null,
        comments: issue.fields?.comment?.comments?.map((c: any) => ({
          id: c.id,
          author: c.author?.displayName,
          created: c.created,
          body: adfToPlainText(c.body).trim(),
        })),
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_search': {
      const jql = args?.jql as string;
      const fields = (args?.fields as string[]) || ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated'];
      const maxResults = Math.min((args?.maxResults as number) || 25, 100);
      const nextPageToken = args?.nextPageToken as string | undefined;
      const searchResult = await jiraRequest<any>('POST', '/search/jql', {
        jql,
        fields,
        maxResults,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        nextPageToken: searchResult.nextPageToken,
        issues: (searchResult.issues || []).map((i: any) => summarizeJiraIssue(i, creds.host)),
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_create_issue': {
      const projectKey = args?.projectKey as string;
      const summary = args?.summary as string;
      const issueType = (args?.issueType as string) || 'Task';
      const description = args?.description;
      const assigneeAccountId = args?.assigneeAccountId as string | undefined;
      const labels = args?.labels as string[] | undefined;
      const priority = args?.priority as string | undefined;
      const parentKey = args?.parentKey as string | undefined;

      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
      };
      if (description !== undefined) fields.description = toAdf(description);
      if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
      if (labels) fields.labels = labels;
      if (priority) fields.priority = { name: priority };
      if (parentKey) fields.parent = { key: parentKey };

      const created = await jiraRequest<any>('POST', '/issue', { fields });
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        key: created.key,
        id: created.id,
        url: `${creds.host}/browse/${created.key}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_update_issue': {
      const issueKey = args?.issueKey as string;
      const fields: Record<string, unknown> = { ...(args?.fields as Record<string, unknown> | undefined ?? {}) };

      if (args?.summary !== undefined) fields.summary = args.summary;
      if (args?.description !== undefined) fields.description = toAdf(args.description);
      if (args?.assigneeAccountId !== undefined) {
        fields.assignee = args.assigneeAccountId ? { accountId: args.assigneeAccountId as string } : null;
      }
      if (args?.labels !== undefined) fields.labels = args.labels;
      if (args?.priority !== undefined) fields.priority = { name: args.priority as string };

      await jiraRequest<void>('PUT', `/issue/${encodeURIComponent(issueKey)}`, { fields });
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        key: issueKey,
        updated: Object.keys(fields),
        url: `${creds.host}/browse/${issueKey}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_add_comment': {
      const issueKey = args?.issueKey as string;
      const body = toAdf(args?.body);
      const comment = await jiraRequest<any>('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, { body });
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        id: comment.id,
        issueKey,
        author: comment.author?.displayName,
        created: comment.created,
        url: `${creds.host}/browse/${issueKey}?focusedCommentId=${comment.id}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_list_transitions': {
      const issueKey = args?.issueKey as string;
      const data = await jiraRequest<any>('GET', `/issue/${encodeURIComponent(issueKey)}/transitions`);
      result = { content: [{ type: 'text', text: JSON.stringify({
        transitions: (data.transitions || []).map((t: any) => ({
          id: t.id,
          name: t.name,
          toStatus: t.to?.name,
        })),
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_transition_issue': {
      const issueKey = args?.issueKey as string;
      let transitionId = args?.transitionId as string | undefined;
      const transitionName = args?.transitionName as string | undefined;

      if (!transitionId && transitionName) {
        const data = await jiraRequest<any>('GET', `/issue/${encodeURIComponent(issueKey)}/transitions`);
        const match = (data.transitions || []).find((t: any) => t.name?.toLowerCase() === transitionName.toLowerCase());
        if (!match) {
          const available = (data.transitions || []).map((t: any) => t.name).join(', ');
          throw new Error(`No transition matching "${transitionName}". Available: ${available || '(none)'}`);
        }
        transitionId = match.id;
      }
      if (!transitionId) throw new Error('transitionId or transitionName is required');

      const payload: Record<string, unknown> = { transition: { id: transitionId } };
      if (args?.comment !== undefined) {
        payload.update = { comment: [{ add: { body: toAdf(args.comment) } }] };
      }

      await jiraRequest<void>('POST', `/issue/${encodeURIComponent(issueKey)}/transitions`, payload);
      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        key: issueKey,
        transitionId,
        url: `${creds.host}/browse/${issueKey}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_enhance': {
      const issueKey = args?.issueKey as string;
      const mode = (args?.mode as string) || 'full';
      const instructions = args?.instructions as string | undefined;
      const apply = args?.apply === true;

      // 1. Pull the current issue
      const issue = await jiraRequest<any>('GET', `/issue/${encodeURIComponent(issueKey)}?fields=summary,description,issuetype,labels,priority`);
      const summary = issue.fields?.summary || '';
      const descriptionText = issue.fields?.description ? adfToPlainText(issue.fields.description).trim() : '';
      const issueType = issue.fields?.issuetype?.name || 'Task';
      const labels: string[] = issue.fields?.labels || [];

      // 2. Ask Claude to enhance it
      const userPrompt = [
        `Mode: ${mode}`,
        `Issue key: ${issueKey}`,
        `Issue type: ${issueType}`,
        labels.length ? `Labels: ${labels.join(', ')}` : '',
        instructions ? `Extra instructions: ${instructions}` : '',
        '',
        `Current summary:\n${summary}`,
        '',
        `Current description:\n${descriptionText || '(empty)'}`,
      ].filter(Boolean).join('\n');

      const client = await getAnthropicClient();
      const stream = client.messages.stream({
        model: ENHANCE_MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: JIRA_ENHANCE_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt }],
      });
      const message = await stream.finalMessage();
      const enhanced = claudeText(message);

      // 3. Optionally write the enhanced text back as the description
      let applied = false;
      if (apply && enhanced) {
        await jiraRequest<void>('PUT', `/issue/${encodeURIComponent(issueKey)}`, {
          fields: { description: toAdf(enhanced) },
        });
        applied = true;
      }

      const creds = await getJiraCredentials();
      result = { content: [{ type: 'text', text: JSON.stringify({
        key: issueKey,
        mode,
        applied,
        model: ENHANCE_MODEL,
        usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
        enhanced,
        url: `${creds.host}/browse/${issueKey}`,
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_get_sprints': {
      let boardId = args?.boardId as number | undefined;
      const projectKey = (args?.projectKey as string) || 'DM';
      const state = (args?.state as string) || 'active,future';

      // Resolve a board if none supplied
      if (!boardId) {
        const boards = await jiraAgileRequest<any>('GET', `/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=1`);
        boardId = boards.values?.[0]?.id;
        if (!boardId) throw new Error(`No board found for project ${projectKey}`);
      }

      const data = await jiraAgileRequest<any>('GET', `/board/${boardId}/sprint?state=${encodeURIComponent(state)}`);
      result = { content: [{ type: 'text', text: JSON.stringify({
        boardId,
        count: data.values?.length || 0,
        sprints: (data.values || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          state: s.state,
          startDate: s.startDate,
          endDate: s.endDate,
          goal: s.goal,
        })),
      }, null, 2) }] };
      break;
    }

    case 'dm_jira_add_issues_to_sprint': {
      const sprintId = args?.sprintId as number;
      const issueKeys = (args?.issueKeys as string[]) || [];
      if (!issueKeys.length) throw new Error('issueKeys must be a non-empty array');
      if (issueKeys.length > 50) throw new Error('Jira allows at most 50 issues per add-to-sprint call');

      await jiraAgileRequest<void>('POST', `/sprint/${sprintId}/issue`, { issues: issueKeys });
      result = { content: [{ type: 'text', text: JSON.stringify({
        sprintId,
        added: issueKeys,
        count: issueKeys.length,
      }, null, 2) }] };
      break;
    }

    // Google Analytics tools
    case 'dm_ga_report': {
      const metrics = (args?.metrics as string[]) || ['sessions'];
      const dimensions = args?.dimensions as string[] | undefined;
      const startDate = (args?.startDate as string) || '7daysAgo';
      const endDate = (args?.endDate as string) || 'today';
      const limit = (args?.limit as number) || 100;
      const orderBy = args?.orderBy as string | undefined;
      const descending = args?.descending !== false;

      const request: GAReportRequest = {
        dateRanges: [{ startDate, endDate }],
        metrics: metrics.map(m => ({ name: m })),
        limit,
      };

      if (dimensions?.length) {
        request.dimensions = dimensions.map(d => ({ name: d }));
      }

      if (orderBy) {
        const isMetric = metrics.includes(orderBy);
        request.orderBys = [{
          ...(isMetric ? { metric: { metricName: orderBy } } : { dimension: { dimensionName: orderBy } }),
          desc: descending,
        }];
      }

      const gaResult = await runGAReport(request);
      result = { content: [{ type: 'text', text: JSON.stringify(gaResult, null, 2) }] };
      break;
    }

    case 'dm_ga_realtime': {
      const metrics = (args?.metrics as string[]) || ['activeUsers'];
      const dimensions = args?.dimensions as string[] | undefined;

      const request: { dimensions?: Array<{ name: string }>; metrics: Array<{ name: string }> } = {
        metrics: metrics.map(m => ({ name: m })),
      };

      if (dimensions?.length) {
        request.dimensions = dimensions.map(d => ({ name: d }));
      }

      const gaResult = await runGARealtimeReport(request);
      result = { content: [{ type: 'text', text: JSON.stringify(gaResult, null, 2) }] };
      break;
    }

    case 'dm_ga_summary': {
      const period = (args?.period as string) || '7days';
      const dateMap: Record<string, { start: string; end: string }> = {
        today: { start: 'today', end: 'today' },
        '7days': { start: '7daysAgo', end: 'today' },
        '30days': { start: '30daysAgo', end: 'today' },
        '90days': { start: '90daysAgo', end: 'today' },
      };
      const { start, end } = dateMap[period] || dateMap['7days'];

      // Run multiple reports in parallel for a comprehensive summary
      const [overview, topPages, sources, devices] = await Promise.all([
        // Overall metrics
        runGAReport({
          dateRanges: [{ startDate: start, endDate: end }],
          metrics: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'screenPageViews' },
            { name: 'averageSessionDuration' },
            { name: 'bounceRate' },
            { name: 'eventCount' },
          ],
        }),
        // Top pages
        runGAReport({
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 10,
        }),
        // Traffic sources
        runGAReport({
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: 'sessionSource' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10,
        }),
        // Device breakdown
        runGAReport({
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        }),
      ]);

      result = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            period,
            dateRange: { start, end },
            overview,
            topPages,
            sources,
            devices,
          }, null, 2),
        }],
      };
      break;
    }

    // GA Admin tools
    case 'dm_ga_admin_accounts': {
      const accounts = await listGAAccounts();
      result = { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
      break;
    }

    case 'dm_ga_admin_properties': {
      const accountId = args?.accountId as string | undefined;
      const properties = await listGAProperties(accountId);
      result = { content: [{ type: 'text', text: JSON.stringify(properties, null, 2) }] };
      break;
    }

    case 'dm_ga_admin_audiences': {
      const action = (args?.action as string) || 'list';
      if (action === 'create' && args?.audience) {
        const audience = await createGAAudience(GA_PROPERTY_ID, args.audience);
        result = { content: [{ type: 'text', text: JSON.stringify(audience, null, 2) }] };
      } else {
        const audiences = await listGAAudiences();
        result = { content: [{ type: 'text', text: JSON.stringify(audiences, null, 2) }] };
      }
      break;
    }

    case 'dm_ga_admin_custom_dimensions': {
      const action = (args?.action as string) || 'list';
      if (action === 'create' && args?.dimension) {
        const dimension = await createGACustomDimension(GA_PROPERTY_ID, args.dimension);
        result = { content: [{ type: 'text', text: JSON.stringify(dimension, null, 2) }] };
      } else {
        const dimensions = await listGACustomDimensions();
        result = { content: [{ type: 'text', text: JSON.stringify(dimensions, null, 2) }] };
      }
      break;
    }

    case 'dm_ga_admin_conversions': {
      const action = (args?.action as string) || 'list';
      if (action === 'create' && args?.eventName) {
        const conversion = await createGAConversionEvent(GA_PROPERTY_ID, args.eventName as string);
        result = { content: [{ type: 'text', text: JSON.stringify(conversion, null, 2) }] };
      } else {
        const conversions = await listGAConversionEvents();
        result = { content: [{ type: 'text', text: JSON.stringify(conversions, null, 2) }] };
      }
      break;
    }

    // Google Ads tools
    case 'dm_ads_query': {
      const query = args?.query as string;
      if (!query) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Query is required' }) }], isError: true };
      }
      const queryResult = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(queryResult, null, 2) }] };
      break;
    }

    case 'dm_ads_campaigns': {
      const status = (args?.status as string) || 'ALL';
      const dateRange = (args?.dateRange as string) || 'LAST_30_DAYS';
      const statusFilter = status === 'ALL' ? '' : `AND campaign.status = '${status}'`;
      const query = `
        SELECT
          campaign.id, campaign.name, campaign.status,
          campaign.advertising_channel_type,
          metrics.impressions, metrics.clicks, metrics.ctr,
          metrics.average_cpc, metrics.conversions, metrics.cost_micros
        FROM campaign
        WHERE segments.date DURING ${dateRange} ${statusFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `;
      const campaigns = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(campaigns, null, 2) }] };
      break;
    }

    case 'dm_ads_ad_groups': {
      const campaignId = args?.campaignId as string | undefined;
      const dateRange = (args?.dateRange as string) || 'LAST_30_DAYS';
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : '';
      const query = `
        SELECT
          ad_group.id, ad_group.name, ad_group.status,
          campaign.name,
          metrics.impressions, metrics.clicks, metrics.ctr,
          metrics.average_cpc, metrics.conversions, metrics.cost_micros
        FROM ad_group
        WHERE segments.date DURING ${dateRange} ${campaignFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `;
      const adGroups = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(adGroups, null, 2) }] };
      break;
    }

    case 'dm_ads_keywords': {
      const campaignId = args?.campaignId as string | undefined;
      const adGroupId = args?.adGroupId as string | undefined;
      const dateRange = (args?.dateRange as string) || 'LAST_30_DAYS';
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : '';
      const adGroupFilter = adGroupId ? `AND ad_group.id = ${adGroupId}` : '';
      const query = `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group_criterion.quality_info.quality_score,
          campaign.name, ad_group.name,
          metrics.impressions, metrics.clicks, metrics.ctr,
          metrics.average_cpc, metrics.conversions, metrics.cost_micros
        FROM keyword_view
        WHERE segments.date DURING ${dateRange} ${campaignFilter} ${adGroupFilter}
        ORDER BY metrics.impressions DESC
        LIMIT 100
      `;
      const keywords = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(keywords, null, 2) }] };
      break;
    }

    case 'dm_ads_manage': {
      const action = args?.action as string;
      const resourceId = args?.resourceId as string;
      if (!action || !resourceId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Action and resourceId are required' }) }], isError: true };
      }

      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      // Map actions to resource types and status changes
      const actionConfig: Record<string, { resourceType: string; status: string }> = {
        'pause_campaign': { resourceType: 'campaign', status: 'PAUSED' },
        'enable_campaign': { resourceType: 'campaign', status: 'ENABLED' },
        'remove_campaign': { resourceType: 'campaign', status: 'REMOVED' },
        'pause_ad_group': { resourceType: 'ad_group', status: 'PAUSED' },
        'enable_ad_group': { resourceType: 'ad_group', status: 'ENABLED' },
        'remove_ad_group': { resourceType: 'ad_group', status: 'REMOVED' },
        'pause_ad': { resourceType: 'ad_group_ad', status: 'PAUSED' },
        'enable_ad': { resourceType: 'ad_group_ad', status: 'ENABLED' },
        'remove_ad': { resourceType: 'ad_group_ad', status: 'REMOVED' },
      };

      const config = actionConfig[action];
      if (!config) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown action: ${action}` }) }], isError: true };
      }

      const resourceName = `customers/${customerId}/${config.resourceType === 'ad_group' ? 'adGroups' : config.resourceType === 'ad_group_ad' ? 'adGroupAds' : 'campaigns'}/${resourceId}`;

      const mutateResult = await mutateGoogleAds(config.resourceType, [{
        update: { resourceName, status: config.status },
        updateMask: 'status',
      }]);

      result = { content: [{ type: 'text', text: JSON.stringify(mutateResult, null, 2) }] };
      break;
    }

    case 'dm_ads_asset_groups': {
      const campaignId = args?.campaignId as string | undefined;
      const campaignFilter = campaignId ? `WHERE campaign.id = ${campaignId}` : '';
      const query = `
        SELECT
          asset_group.id, asset_group.name, asset_group.status,
          asset_group.final_urls, asset_group.path1, asset_group.path2,
          campaign.name
        FROM asset_group
        ${campaignFilter}
        ORDER BY asset_group.id
        LIMIT 100
      `;
      const assetGroups = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(assetGroups, null, 2) }] };
      break;
    }

    case 'dm_ads_asset_group_assets': {
      const assetGroupId = args?.assetGroupId as string;
      if (!assetGroupId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'assetGroupId is required' }) }], isError: true };
      }
      const query = `
        SELECT
          asset_group_asset.resource_name,
          asset_group_asset.field_type,
          asset_group_asset.status,
          asset.resource_name,
          asset.type,
          asset.text_asset.text,
          asset.image_asset.full_size.url,
          asset.youtube_video_asset.youtube_video_id
        FROM asset_group_asset
        WHERE asset_group.id = ${assetGroupId}
        ORDER BY asset_group_asset.field_type
      `;
      const assets = await searchGoogleAds(query);
      result = { content: [{ type: 'text', text: JSON.stringify(assets, null, 2) }] };
      break;
    }

    case 'dm_ads_mutate': {
      const operations = args?.operations as Array<{
        resourceType: string;
        operation: string;
        resource?: unknown;
        resourceName?: string;
        updateMask?: string;
      }>;

      if (!operations || !Array.isArray(operations) || operations.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'operations array is required' }) }], isError: true };
      }

      // Validate budget/bid values against safety cap
      for (const op of operations) {
        if (op.resource) {
          const capError = validateBudgetCap(op.resource);
          if (capError) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: capError }) }], isError: true };
          }
        }
      }

      const results: unknown[] = [];
      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      // Group operations by resource type
      const groupedOps: Record<string, Array<{ create?: unknown; update?: unknown; remove?: string; updateMask?: string }>> = {};

      for (const op of operations) {
        const { resourceType, operation, resource, resourceName, updateMask } = op;
        if (!groupedOps[resourceType]) groupedOps[resourceType] = [];

        if (operation === 'create' && resource) {
          groupedOps[resourceType].push({ create: resource });
        } else if (operation === 'update' && resourceName && resource) {
          groupedOps[resourceType].push({ update: { ...resource as object, resourceName }, updateMask });
        } else if (operation === 'remove' && resourceName) {
          groupedOps[resourceType].push({ remove: resourceName });
        }
      }

      for (const [resourceType, ops] of Object.entries(groupedOps)) {
        const mutateResult = await mutateGoogleAds(resourceType, ops);
        results.push({ resourceType, result: mutateResult });
      }

      result = { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      break;
    }

    case 'dm_ads_create_responsive_search_ad': {
      const adGroupId = args?.adGroupId as string;
      const headlines = args?.headlines as string[];
      const descriptions = args?.descriptions as string[];
      const finalUrls = args?.finalUrls as string[];
      const path1 = args?.path1 as string | undefined;
      const path2 = args?.path2 as string | undefined;

      if (!adGroupId || !headlines || !descriptions || !finalUrls) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'adGroupId, headlines, descriptions, and finalUrls are required' }) }], isError: true };
      }

      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      const ad = {
        adGroup: `customers/${customerId}/adGroups/${adGroupId}`,
        ad: {
          responsiveSearchAd: {
            headlines: headlines.map((text, i) => ({ text, pinnedField: i < 3 ? undefined : undefined })),
            descriptions: descriptions.map(text => ({ text })),
            path1,
            path2,
          },
          finalUrls,
        },
      };

      const mutateResult = await mutateGoogleAds('ad_group_ad', [{ create: ad }]);
      result = { content: [{ type: 'text', text: JSON.stringify(mutateResult, null, 2) }] };
      break;
    }

    case 'dm_ads_add_keywords': {
      const adGroupId = args?.adGroupId as string;
      const keywords = args?.keywords as Array<{ text: string; matchType: string }>;

      if (!adGroupId || !keywords || !Array.isArray(keywords)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'adGroupId and keywords array are required' }) }], isError: true };
      }

      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      const operations = keywords.map(kw => ({
        create: {
          adGroup: `customers/${customerId}/adGroups/${adGroupId}`,
          keyword: {
            text: kw.text,
            matchType: kw.matchType,
          },
          status: 'ENABLED',
        },
      }));

      const mutateResult = await mutateGoogleAds('ad_group_criterion', operations);
      result = { content: [{ type: 'text', text: JSON.stringify(mutateResult, null, 2) }] };
      break;
    }

    case 'dm_ads_update_asset_group': {
      const assetGroupId = args?.assetGroupId as string;
      if (!assetGroupId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'assetGroupId is required' }) }], isError: true };
      }

      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      const updateFields: Record<string, unknown> = {
        resourceName: `customers/${customerId}/assetGroups/${assetGroupId}`,
      };
      const updateMaskFields: string[] = [];

      if (args?.name) { updateFields.name = args.name; updateMaskFields.push('name'); }
      if (args?.status) { updateFields.status = args.status; updateMaskFields.push('status'); }
      if (args?.finalUrls) { updateFields.finalUrls = args.finalUrls; updateMaskFields.push('final_urls'); }
      if (args?.path1) { updateFields.path1 = args.path1; updateMaskFields.push('path1'); }
      if (args?.path2) { updateFields.path2 = args.path2; updateMaskFields.push('path2'); }

      if (updateMaskFields.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'At least one field to update is required' }) }], isError: true };
      }

      const mutateResult = await mutateGoogleAds('asset_group', [{
        update: updateFields,
        updateMask: updateMaskFields.join(','),
      }]);

      result = { content: [{ type: 'text', text: JSON.stringify(mutateResult, null, 2) }] };
      break;
    }

    case 'dm_ads_add_asset_to_group': {
      const assetGroupId = args?.assetGroupId as string;
      const assetType = args?.assetType as string;
      const textContent = args?.textContent as string | undefined;
      const imageUrl = args?.imageUrl as string | undefined;
      const youtubeVideoId = args?.youtubeVideoId as string | undefined;

      if (!assetGroupId || !assetType) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'assetGroupId and assetType are required' }) }], isError: true };
      }

      const adsConfig = await getGoogleAdsConfig();
      const customerId = adsConfig.customerId.replace(/-/g, '');

      // First, create the asset
      let assetData: { textAsset?: { text: string }; imageAsset?: { data: string }; youtubeVideoAsset?: { youtubeVideoId: string } } = {};

      if (textContent) {
        assetData = { textAsset: { text: textContent } };
      } else if (youtubeVideoId) {
        assetData = { youtubeVideoAsset: { youtubeVideoId } };
      } else if (imageUrl) {
        // For images, we'd need to fetch and base64 encode - for now return an error
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Image upload not yet supported. Use textContent or youtubeVideoId.' }) }], isError: true };
      } else {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'textContent, imageUrl, or youtubeVideoId is required' }) }], isError: true };
      }

      const assetResourceName = await createAsset(assetData);

      // Then link it to the asset group
      const assetGroupAsset = {
        assetGroup: `customers/${customerId}/assetGroups/${assetGroupId}`,
        asset: assetResourceName,
        fieldType: assetType,
      };

      const mutateResult = await mutateGoogleAds('asset_group_asset', [{ create: assetGroupAsset }]);
      result = { content: [{ type: 'text', text: JSON.stringify({ assetResourceName, linkResult: mutateResult }, null, 2) }] };
      break;
    }

    case 'dm_ads_remove_asset_from_group': {
      const resourceName = args?.assetGroupAssetResourceName as string;
      if (!resourceName) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'assetGroupAssetResourceName is required' }) }], isError: true };
      }

      const mutateResult = await mutateGoogleAds('asset_group_asset', [{ remove: resourceName }]);
      result = { content: [{ type: 'text', text: JSON.stringify(mutateResult, null, 2) }] };
      break;
    }

    default: {
      const duration = Date.now() - startTime;
      console.warn('[tool] unknown tool', { tool: name, duration });
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  }

    // Log successful completion
    const duration = Date.now() - startTime;
    console.info('[tool] invocation complete', { tool: name, duration, success: true });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[tool] invocation failed', { tool: name, duration, error: errorMessage });
    return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }], isError: true };
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
