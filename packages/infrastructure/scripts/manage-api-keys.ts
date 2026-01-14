#!/usr/bin/env npx ts-node

/**
 * DonateMate MCP API Key Management
 *
 * Commands:
 *   create    - Create a new API key
 *   list      - List all API keys (shows prefix, user, expiry)
 *   rotate    - Rotate a key (creates new, deprecates old)
 *   revoke    - Revoke an API key by prefix
 *   cleanup   - Remove expired keys
 *
 * Usage:
 *   npx ts-node manage-api-keys.ts create --env staging --user admin --name "Claude Code" --days 90
 *   npx ts-node manage-api-keys.ts list --env staging
 *   npx ts-node manage-api-keys.ts rotate --env staging --prefix dm_TT9sL
 *   npx ts-node manage-api-keys.ts revoke --env staging --prefix dm_TT9sL
 *   npx ts-node manage-api-keys.ts cleanup --env staging
 */

import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { randomBytes, createHash } from 'crypto';

const API_KEY_PREFIX = 'dm_';
const client = new DynamoDBClient({ region: 'us-east-2' });

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

interface Options {
  command: string;
  env: 'staging' | 'production';
  userId?: string;
  name?: string;
  days?: number;
  prefix?: string;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    command: args[0] || 'help',
    env: 'staging',
    days: 90,
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--env':
        options.env = args[++i] as 'staging' | 'production';
        break;
      case '--user':
        options.userId = args[++i];
        break;
      case '--name':
        options.name = args[++i];
        break;
      case '--days':
        options.days = parseInt(args[++i], 10);
        break;
      case '--prefix':
        options.prefix = args[++i];
        break;
    }
  }

  return options;
}

function getTableName(env: string): string {
  return `donatemate-${env}-mcp-api-keys-v2`;
}

async function createKey(options: Options): Promise<void> {
  if (!options.userId || !options.name) {
    console.error('Error: --user and --name are required for create command');
    process.exit(1);
  }

  const tableName = getTableName(options.env);
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 8);
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + (options.days || 90) * 24 * 60 * 60;
  const expiresDate = new Date(expiresAt * 1000);

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        keyHash: { S: keyHash },
        keyPrefix: { S: keyPrefix },
        userId: { S: options.userId },
        name: { S: options.name },
        email: { S: `${options.userId}@donatemate.com` },
        createdAt: { S: now.toISOString() },
        expiresAt: { N: String(expiresAt) },
        revoked: { BOOL: false },
        status: { S: 'active' },
      },
    })
  );

  console.log('\n✅ API key created successfully!\n');
  console.log('='.repeat(60));
  console.log('⚠️  SAVE THIS KEY - IT CANNOT BE RETRIEVED LATER ⚠️');
  console.log('='.repeat(60));
  console.log(`\n${apiKey}\n`);
  console.log('='.repeat(60));
  console.log(`Key ID: ${keyPrefix}...`);
  console.log(`User: ${options.userId}`);
  console.log(`Name: ${options.name}`);
  console.log(`Expires: ${expiresDate.toISOString()}`);
  console.log('='.repeat(60));

  console.log('\nUsage in Claude config:');
  console.log(JSON.stringify({
    mcpServers: {
      donatemate: {
        url: 'https://na7zt9rxi7.execute-api.us-east-2.amazonaws.com/mcp',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    },
  }, null, 2));
}

async function listKeys(options: Options): Promise<void> {
  const tableName = getTableName(options.env);

  const result = await client.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'keyPrefix, userId, #n, createdAt, expiresAt, revoked, #s',
      ExpressionAttributeNames: {
        '#n': 'name',
        '#s': 'status',
      },
    })
  );

  if (!result.Items || result.Items.length === 0) {
    console.log('No API keys found.');
    return;
  }

  console.log('\nAPI Keys:\n');
  console.log('Prefix      | User           | Name                 | Status    | Expires');
  console.log('-'.repeat(85));

  const now = Math.floor(Date.now() / 1000);

  for (const item of result.Items) {
    const prefix = item.keyPrefix?.S || '???';
    const user = (item.userId?.S || 'unknown').padEnd(14);
    const name = (item.name?.S || 'unnamed').substring(0, 20).padEnd(20);
    const expiresAt = parseInt(item.expiresAt?.N || '0', 10);
    const isRevoked = item.revoked?.BOOL || false;
    const status = item.status?.S || 'active';

    let statusDisplay: string;
    if (isRevoked) {
      statusDisplay = 'REVOKED'.padEnd(9);
    } else if (expiresAt < now) {
      statusDisplay = 'EXPIRED'.padEnd(9);
    } else if (status === 'deprecated') {
      statusDisplay = 'DEPRECATED'.substring(0, 9).padEnd(9);
    } else {
      statusDisplay = 'active'.padEnd(9);
    }

    const expiresDate = new Date(expiresAt * 1000).toISOString().split('T')[0];

    console.log(`${prefix}... | ${user} | ${name} | ${statusDisplay} | ${expiresDate}`);
  }

  console.log(`\nTotal: ${result.Items.length} keys`);
}

async function rotateKey(options: Options): Promise<void> {
  if (!options.prefix) {
    console.error('Error: --prefix is required for rotate command');
    process.exit(1);
  }

  const tableName = getTableName(options.env);

  // Find the key by prefix
  const queryResult = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'keyPrefix-index',
      KeyConditionExpression: 'keyPrefix = :prefix',
      ExpressionAttributeValues: {
        ':prefix': { S: options.prefix },
      },
    })
  );

  if (!queryResult.Items || queryResult.Items.length === 0) {
    console.error(`Error: No key found with prefix ${options.prefix}`);
    process.exit(1);
  }

  const oldKey = queryResult.Items[0];
  const userId = oldKey.userId?.S || 'unknown';
  const name = oldKey.name?.S || 'rotated';

  // Mark old key as deprecated (still works for 7 days)
  const deprecationExpiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await client.send(
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

  console.log(`\n⚠️  Old key ${options.prefix}... marked as DEPRECATED`);
  console.log(`   It will continue working for 7 days until ${new Date(deprecationExpiry * 1000).toISOString()}`);

  // Create new key
  const newApiKey = generateApiKey();
  const newKeyHash = hashApiKey(newApiKey);
  const newKeyPrefix = newApiKey.substring(0, 8);
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + (options.days || 90) * 24 * 60 * 60;

  await client.send(
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
        rotatedFrom: { S: options.prefix },
      },
    })
  );

  console.log('\n✅ New API key created!\n');
  console.log('='.repeat(60));
  console.log('⚠️  SAVE THIS KEY - IT CANNOT BE RETRIEVED LATER ⚠️');
  console.log('='.repeat(60));
  console.log(`\n${newApiKey}\n`);
  console.log('='.repeat(60));
  console.log(`New Key ID: ${newKeyPrefix}...`);
  console.log(`Old Key ID: ${options.prefix}... (deprecated, expires in 7 days)`);
  console.log('='.repeat(60));
}

async function revokeKey(options: Options): Promise<void> {
  if (!options.prefix) {
    console.error('Error: --prefix is required for revoke command');
    process.exit(1);
  }

  const tableName = getTableName(options.env);

  // Find the key by prefix
  const queryResult = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'keyPrefix-index',
      KeyConditionExpression: 'keyPrefix = :prefix',
      ExpressionAttributeValues: {
        ':prefix': { S: options.prefix },
      },
    })
  );

  if (!queryResult.Items || queryResult.Items.length === 0) {
    console.error(`Error: No key found with prefix ${options.prefix}`);
    process.exit(1);
  }

  const key = queryResult.Items[0];

  await client.send(
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

  console.log(`\n✅ Key ${options.prefix}... has been REVOKED`);
  console.log('   It will no longer work for authentication.');
}

async function cleanupKeys(options: Options): Promise<void> {
  const tableName = getTableName(options.env);
  const now = Math.floor(Date.now() / 1000);

  const result = await client.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'expiresAt < :now OR revoked = :revoked',
      ExpressionAttributeValues: {
        ':now': { N: String(now) },
        ':revoked': { BOOL: true },
      },
    })
  );

  if (!result.Items || result.Items.length === 0) {
    console.log('No expired or revoked keys to clean up.');
    return;
  }

  console.log(`Found ${result.Items.length} keys to clean up:\n`);

  for (const item of result.Items) {
    const prefix = item.keyPrefix?.S || '???';
    const isRevoked = item.revoked?.BOOL;
    const reason = isRevoked ? 'revoked' : 'expired';

    await client.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { keyHash: item.keyHash },
      })
    );

    console.log(`  Deleted ${prefix}... (${reason})`);
  }

  console.log(`\n✅ Cleaned up ${result.Items.length} keys`);
}

function showHelp(): void {
  console.log(`
DonateMate MCP API Key Management

Commands:
  create    Create a new API key
            --user USER_ID    User ID (required)
            --name NAME       Key name (required)
            --days DAYS       Expiration days (default: 90)

  list      List all API keys

  rotate    Rotate a key (creates new, deprecates old for 7 days)
            --prefix PREFIX   Key prefix to rotate (e.g., dm_TT9sL)

  revoke    Immediately revoke an API key
            --prefix PREFIX   Key prefix to revoke

  cleanup   Delete expired and revoked keys

Global Options:
  --env staging|production    Environment (default: staging)

Examples:
  npx ts-node manage-api-keys.ts create --env staging --user admin --name "Claude Code" --days 90
  npx ts-node manage-api-keys.ts list --env staging
  npx ts-node manage-api-keys.ts rotate --env staging --prefix dm_TT9sL
  npx ts-node manage-api-keys.ts revoke --env staging --prefix dm_TT9sL
  npx ts-node manage-api-keys.ts cleanup --env staging
`);
}

async function main() {
  const options = parseArgs();

  switch (options.command) {
    case 'create':
      await createKey(options);
      break;
    case 'list':
      await listKeys(options);
      break;
    case 'rotate':
      await rotateKey(options);
      break;
    case 'revoke':
      await revokeKey(options);
      break;
    case 'cleanup':
      await cleanupKeys(options);
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
