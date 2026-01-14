/**
 * MCP Admin API Handler
 *
 * Handles API key management operations for root admin users.
 * All requests must be authenticated with a valid Cognito JWT.
 *
 * Endpoints:
 *   GET    /admin/keys          - List all API keys
 *   POST   /admin/keys          - Create a new API key
 *   POST   /admin/keys/:prefix/rotate - Rotate a key
 *   DELETE /admin/keys/:prefix  - Revoke a key
 */

import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { randomBytes, createHash } from 'crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const API_KEY_PREFIX = 'dm_';

// Root admin user IDs that can manage API keys
const ROOT_ADMIN_EMAILS = [
  'andrew.sheehy@donate-mate.com',
  'admin@donate-mate.com',
];

// Cache the verifier instance
let jwtVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function getVerifier() {
  if (!jwtVerifier) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (!userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID not configured');
    }
    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'id',
      clientId: null,
    });
  }
  return jwtVerifier;
}

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function generateApiKey(): string {
  const randomData = randomBytes(32);
  const encoded = randomData
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${API_KEY_PREFIX}${encoded}`;
}

function response(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

async function validateAdminAuth(event: APIGatewayProxyEventV2): Promise<{ userId: string; email: string } | null> {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  try {
    const verifier = getVerifier();
    const payload = await verifier.verify(token);
    const email = (payload.email as string) || '';

    // Check if user is a root admin
    if (!ROOT_ADMIN_EMAILS.includes(email.toLowerCase())) {
      console.warn('Non-admin user attempted key management', { email });
      return null;
    }

    return {
      userId: payload.sub,
      email,
    };
  } catch (error) {
    console.error('JWT verification failed', { error });
    return null;
  }
}

async function listKeys(): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) {
    return response(500, { error: 'API_KEYS_TABLE_NAME not configured' });
  }

  const result = await dynamoClient.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'keyPrefix, userId, #n, createdAt, expiresAt, revoked, #s, rateLimit',
      ExpressionAttributeNames: {
        '#n': 'name',
        '#s': 'status',
      },
    })
  );

  const now = Math.floor(Date.now() / 1000);
  const keys = (result.Items || []).map((item) => {
    const expiresAt = parseInt(item.expiresAt?.N || '0', 10);
    const isRevoked = item.revoked?.BOOL || false;
    const status = item.status?.S || 'active';

    let computedStatus: string;
    if (isRevoked) {
      computedStatus = 'revoked';
    } else if (expiresAt < now) {
      computedStatus = 'expired';
    } else if (status === 'deprecated') {
      computedStatus = 'deprecated';
    } else {
      computedStatus = 'active';
    }

    return {
      keyPrefix: item.keyPrefix?.S || '',
      userId: item.userId?.S || '',
      name: item.name?.S || '',
      createdAt: item.createdAt?.S || '',
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      status: computedStatus,
      rateLimit: parseInt(item.rateLimit?.N || '1000', 10),
    };
  });

  return response(200, { keys });
}

async function createKey(body: { userId: string; name: string; days?: number; rateLimit?: number }): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) {
    return response(500, { error: 'API_KEYS_TABLE_NAME not configured' });
  }

  if (!body.userId || !body.name) {
    return response(400, { error: 'userId and name are required' });
  }

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 8);
  const now = new Date();
  const days = body.days || 90;
  const expiresAt = Math.floor(now.getTime() / 1000) + days * 24 * 60 * 60;

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        keyHash: { S: keyHash },
        keyPrefix: { S: keyPrefix },
        userId: { S: body.userId },
        name: { S: body.name },
        email: { S: `${body.userId}@donatemate.com` },
        createdAt: { S: now.toISOString() },
        expiresAt: { N: String(expiresAt) },
        revoked: { BOOL: false },
        status: { S: 'active' },
        rateLimit: { N: String(body.rateLimit || 1000) },
      },
    })
  );

  return response(201, {
    apiKey, // Only returned once at creation
    keyPrefix,
    userId: body.userId,
    name: body.name,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}

async function rotateKey(keyPrefix: string, days?: number): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) {
    return response(500, { error: 'API_KEYS_TABLE_NAME not configured' });
  }

  // Find the key by prefix
  const queryResult = await dynamoClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'keyPrefix-index',
      KeyConditionExpression: 'keyPrefix = :prefix',
      ExpressionAttributeValues: {
        ':prefix': { S: keyPrefix },
      },
    })
  );

  if (!queryResult.Items || queryResult.Items.length === 0) {
    return response(404, { error: `No key found with prefix ${keyPrefix}` });
  }

  const oldKey = queryResult.Items[0];
  const userId = oldKey.userId?.S || 'unknown';
  const name = oldKey.name?.S || 'rotated';
  const rateLimit = parseInt(oldKey.rateLimit?.N || '1000', 10);

  // Mark old key as deprecated (still works for 7 days)
  const deprecationExpiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { keyHash: oldKey.keyHash },
      UpdateExpression: 'SET #s = :status, expiresAt = :expiry, deprecatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'deprecated' },
        ':expiry': { N: String(deprecationExpiry) },
        ':now': { S: new Date().toISOString() },
      },
    })
  );

  // Create new key
  const newApiKey = generateApiKey();
  const newKeyHash = hashApiKey(newApiKey);
  const newKeyPrefix = newApiKey.substring(0, 8);
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + (days || 90) * 24 * 60 * 60;

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        keyHash: { S: newKeyHash },
        keyPrefix: { S: newKeyPrefix },
        userId: { S: userId },
        name: { S: `${name} (rotated)` },
        email: { S: `${userId}@donatemate.com` },
        createdAt: { S: now.toISOString() },
        expiresAt: { N: String(expiresAt) },
        revoked: { BOOL: false },
        status: { S: 'active' },
        rotatedFrom: { S: keyPrefix },
        rateLimit: { N: String(rateLimit) },
      },
    })
  );

  return response(200, {
    newApiKey, // Only returned once at creation
    newKeyPrefix,
    oldKeyPrefix: keyPrefix,
    deprecationExpiry: new Date(deprecationExpiry * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}

async function revokeKey(keyPrefix: string): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.API_KEYS_TABLE_NAME;
  if (!tableName) {
    return response(500, { error: 'API_KEYS_TABLE_NAME not configured' });
  }

  // Find the key by prefix
  const queryResult = await dynamoClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'keyPrefix-index',
      KeyConditionExpression: 'keyPrefix = :prefix',
      ExpressionAttributeValues: {
        ':prefix': { S: keyPrefix },
      },
    })
  );

  if (!queryResult.Items || queryResult.Items.length === 0) {
    return response(404, { error: `No key found with prefix ${keyPrefix}` });
  }

  const key = queryResult.Items[0];

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { keyHash: key.keyHash },
      UpdateExpression: 'SET revoked = :revoked, revokedAt = :now',
      ExpressionAttributeValues: {
        ':revoked': { BOOL: true },
        ':now': { S: new Date().toISOString() },
      },
    })
  );

  return response(200, { message: `Key ${keyPrefix} has been revoked` });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const { requestContext, rawPath, body } = event;
  const method = requestContext.http.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return response(200, {});
  }

  // Validate admin authentication
  const admin = await validateAdminAuth(event);
  if (!admin) {
    return response(401, { error: 'Unauthorized: Admin access required' });
  }

  console.info('Admin request', { admin: admin.email, method, path: rawPath });

  try {
    // Route handling
    // GET /admin/keys
    if (method === 'GET' && rawPath === '/admin/keys') {
      return await listKeys();
    }

    // POST /admin/keys
    if (method === 'POST' && rawPath === '/admin/keys') {
      const parsedBody = body ? JSON.parse(body) : {};
      return await createKey(parsedBody);
    }

    // POST /admin/keys/{prefix}/rotate
    const rotateMatch = rawPath.match(/^\/admin\/keys\/([^/]+)\/rotate$/);
    if (method === 'POST' && rotateMatch) {
      const parsedBody = body ? JSON.parse(body) : {};
      return await rotateKey(rotateMatch[1], parsedBody.days);
    }

    // DELETE /admin/keys/{prefix}
    const deleteMatch = rawPath.match(/^\/admin\/keys\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      return await revokeKey(deleteMatch[1]);
    }

    return response(404, { error: 'Not found' });
  } catch (error) {
    console.error('Admin API error', { error });
    return response(500, { error: 'Internal server error' });
  }
}
