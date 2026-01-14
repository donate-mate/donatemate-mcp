/**
 * MCP WebSocket $connect Handler
 *
 * Validates authentication from query parameters and stores connection state.
 * Supports two auth methods:
 * 1. API Key (dm_xxx format) - long-lived tokens stored as hashes in DynamoDB
 * 2. Cognito JWT - short-lived access tokens from Cognito User Pool
 */

import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createHash } from 'crypto';
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});

// API key prefix for identification
const API_KEY_PREFIX = 'dm_';

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

// Cache the verifier instance
let jwtVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function getVerifier() {
  if (!jwtVerifier) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (!userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID environment variable is required');
    }

    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: null, // Accept any client
    });
  }
  return jwtVerifier;
}

interface AuthResult {
  userId: string;
  email: string;
  authMethod: 'api_key' | 'cognito_jwt';
}

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

  return {
    userId: result.Item.userId?.S || 'unknown',
    email: result.Item.email?.S || result.Item.name?.S || 'api-key-user',
    authMethod: 'api_key',
  };
}

async function validateCognitoJwt(token: string): Promise<AuthResult | null> {
  try {
    const verifier = getVerifier();
    const payload = await verifier.verify(token);

    return {
      userId: payload.sub,
      email: (payload.email as string) || payload.username || 'unknown',
      authMethod: 'cognito_jwt',
    };
  } catch (error) {
    console.error('JWT verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const tableName = process.env.CONNECTIONS_TABLE_NAME;

  if (!tableName) {
    console.error('CONNECTIONS_TABLE_NAME not configured');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  // Extract token from query string
  const token = event.queryStringParameters?.token;
  if (!token) {
    console.warn('Connection rejected: no token provided', { connectionId });
    return { statusCode: 401, body: 'Unauthorized: token required' };
  }

  try {
    // Determine auth method based on token format
    let authResult: AuthResult | null = null;

    if (token.startsWith(API_KEY_PREFIX)) {
      // API key authentication
      console.info('Authenticating with API key', { connectionId });
      authResult = await validateApiKey(token);
    } else {
      // Cognito JWT authentication
      console.info('Authenticating with Cognito JWT', { connectionId });
      authResult = await validateCognitoJwt(token);
    }

    if (!authResult) {
      console.warn('Authentication failed', { connectionId });
      return { statusCode: 401, body: 'Unauthorized: invalid token' };
    }

    const { userId, email, authMethod } = authResult;
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

    // Store connection in DynamoDB
    await dynamoClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          connectionId: { S: connectionId },
          userId: { S: userId },
          email: { S: email },
          authMethod: { S: authMethod },
          connectedAt: { S: now },
          lastActivityAt: { S: now },
          ttl: { N: String(ttl) },
        },
      })
    );

    console.info('Connection established', {
      connectionId,
      userId,
      email,
      authMethod,
    });

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('Connection failed', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { statusCode: 401, body: 'Unauthorized: authentication error' };
  }
}
