/**
 * Knowledge Base Admin Handler
 *
 * Manages integration configurations (CRUD operations).
 * Protected by API key authentication.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});
const lambdaClient = new LambdaClient({});

interface Integration {
  integrationId: string;
  integrationType: 'github' | 'jira' | 'confluence' | 'slack';
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
}

// CORS headers
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function validateApiKey(apiKey: string | undefined): Promise<boolean> {
  if (!apiKey) return false;

  const apiKeysTableName = process.env.API_KEYS_TABLE_NAME;
  if (!apiKeysTableName) return false;

  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  try {
    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: apiKeysTableName,
        Key: { keyHash: { S: keyHash } },
      })
    );

    if (!result.Item) return false;

    // Check expiration
    const expiresAt = result.Item.expiresAt?.N;
    if (expiresAt) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= parseInt(expiresAt, 10)) return false;
    }

    // Check revoked
    if (result.Item.revoked?.BOOL) return false;

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integration CRUD
// ---------------------------------------------------------------------------

async function listIntegrations(): Promise<Integration[]> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) throw new Error('INTEGRATIONS_TABLE_NAME not configured');

  const result = await dynamoClient.send(
    new ScanCommand({ TableName: tableName })
  );

  return (result.Items || []).map((item) => ({
    integrationId: item.integrationId?.S || '',
    integrationType: item.integrationType?.S as Integration['integrationType'],
    name: item.name?.S || '',
    enabled: item.enabled?.BOOL || false,
    config: JSON.parse(item.config?.S || '{}'),
    createdAt: item.createdAt?.S || '',
    updatedAt: item.updatedAt?.S || '',
    lastSyncAt: item.lastSyncAt?.S,
  }));
}

async function getIntegration(integrationId: string): Promise<Integration | null> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) throw new Error('INTEGRATIONS_TABLE_NAME not configured');

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { integrationId: { S: integrationId } },
    })
  );

  if (!result.Item) return null;

  return {
    integrationId: result.Item.integrationId?.S || '',
    integrationType: result.Item.integrationType?.S as Integration['integrationType'],
    name: result.Item.name?.S || '',
    enabled: result.Item.enabled?.BOOL || false,
    config: JSON.parse(result.Item.config?.S || '{}'),
    createdAt: result.Item.createdAt?.S || '',
    updatedAt: result.Item.updatedAt?.S || '',
    lastSyncAt: result.Item.lastSyncAt?.S,
  };
}

async function createIntegration(
  data: Omit<Integration, 'integrationId' | 'createdAt' | 'updatedAt'>
): Promise<Integration> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) throw new Error('INTEGRATIONS_TABLE_NAME not configured');

  const now = new Date().toISOString();
  const integration: Integration = {
    integrationId: randomUUID(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        integrationId: { S: integration.integrationId },
        integrationType: { S: integration.integrationType },
        name: { S: integration.name },
        enabled: { BOOL: integration.enabled },
        config: { S: JSON.stringify(integration.config) },
        createdAt: { S: integration.createdAt },
        updatedAt: { S: integration.updatedAt },
      },
    })
  );

  return integration;
}

async function updateIntegration(
  integrationId: string,
  updates: Partial<Omit<Integration, 'integrationId' | 'createdAt'>>
): Promise<Integration | null> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) throw new Error('INTEGRATIONS_TABLE_NAME not configured');

  const existing = await getIntegration(integrationId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updateExpressions: string[] = ['updatedAt = :updatedAt'];
  const expressionValues: Record<string, any> = {
    ':updatedAt': { S: now },
  };

  if (updates.name !== undefined) {
    updateExpressions.push('name = :name');
    expressionValues[':name'] = { S: updates.name };
  }

  if (updates.enabled !== undefined) {
    updateExpressions.push('enabled = :enabled');
    expressionValues[':enabled'] = { BOOL: updates.enabled };
  }

  if (updates.config !== undefined) {
    updateExpressions.push('config = :config');
    expressionValues[':config'] = { S: JSON.stringify(updates.config) };
  }

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { integrationId: { S: integrationId } },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionValues,
    })
  );

  return getIntegration(integrationId);
}

async function deleteIntegration(integrationId: string): Promise<boolean> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) throw new Error('INTEGRATIONS_TABLE_NAME not configured');

  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { integrationId: { S: integrationId } },
    })
  );

  return true;
}

async function triggerSync(integrationId: string): Promise<void> {
  const syncFunctionArn = process.env.SYNC_FUNCTION_ARN;
  if (!syncFunctionArn) throw new Error('SYNC_FUNCTION_ARN not configured');

  const integration = await getIntegration(integrationId);
  if (!integration) throw new Error('Integration not found');

  // Invoke the sync Lambda asynchronously for the specific integration
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: syncFunctionArn,
      InvocationType: 'Event', // Async invocation
      Payload: JSON.stringify({
        integrationId,
        fullSync: true, // Signal to sync all content, not just recent
      }),
    })
  );
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Validate API key
  const apiKey =
    event.headers['x-api-key'] ||
    event.headers['authorization']?.replace('Bearer ', '');

  if (!(await validateApiKey(apiKey))) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    // Route handling
    const pathParts = path.split('/').filter(Boolean);

    // GET /admin/integrations - List all integrations
    if (method === 'GET' && path === '/admin/integrations') {
      const integrations = await listIntegrations();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ integrations }),
      };
    }

    // POST /admin/integrations - Create new integration
    if (method === 'POST' && path === '/admin/integrations') {
      const body = JSON.parse(event.body || '{}');

      if (!body.integrationType || !body.name) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'integrationType and name are required' }),
        };
      }

      const integration = await createIntegration({
        integrationType: body.integrationType,
        name: body.name,
        enabled: body.enabled ?? true,
        config: body.config || {},
      });

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ integration }),
      };
    }

    // GET /admin/integrations/{id} - Get specific integration
    if (method === 'GET' && pathParts[1] === 'integrations' && pathParts[2]) {
      const integration = await getIntegration(pathParts[2]);

      if (!integration) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Integration not found' }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ integration }),
      };
    }

    // PUT /admin/integrations/{id} - Update integration
    if (method === 'PUT' && pathParts[1] === 'integrations' && pathParts[2]) {
      const body = JSON.parse(event.body || '{}');
      const integration = await updateIntegration(pathParts[2], body);

      if (!integration) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Integration not found' }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ integration }),
      };
    }

    // DELETE /admin/integrations/{id} - Delete integration
    if (method === 'DELETE' && pathParts[1] === 'integrations' && pathParts[2]) {
      await deleteIntegration(pathParts[2]);
      return {
        statusCode: 204,
        headers,
        body: '',
      };
    }

    // POST /admin/integrations/{id}/sync - Trigger sync
    if (
      method === 'POST' &&
      pathParts[1] === 'integrations' &&
      pathParts[2] &&
      pathParts[3] === 'sync'
    ) {
      await triggerSync(pathParts[2]);
      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({ message: 'Sync triggered' }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Admin handler error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
