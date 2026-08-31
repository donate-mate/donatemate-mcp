#!/usr/bin/env npx ts-node

/**
 * Generate a DonateMate MCP API Key
 *
 * API keys are stored as SHA-256 hashes in DynamoDB for security.
 * The full key is only shown once at creation time - save it!
 *
 * Usage:
 *   npx ts-node generate-api-key.ts [options]
 *
 * Options:
 *   --env staging|production  Environment (default: staging)
 *   --user USER_ID            User ID to associate with the key
 *   --name NAME               Name/description for the key
 *   --display-name NAME       Visible verified actor name
 *   --actor-type TYPE         human or service
 *   --client-name NAME        Executing MCP client (defaults to --name)
 *   --email EMAIL             Canonical actor email
 *   --jira-account-id ID      Optional Jira account mapping
 *   --days DAYS               Days until expiration (default: 90)
 *
 * Example:
 *   npx ts-node generate-api-key.ts --env staging --user hermes --name "Hermes MCP key" --display-name "Hermes" --actor-type service --client-name "Hermes Worker" --days 90
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomBytes, createHash } from 'crypto';

const API_KEY_PREFIX = 'dm_';

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

interface Options {
  env: 'staging' | 'production';
  userId: string;
  name: string;
  displayName: string;
  actorType: 'human' | 'service' | '';
  clientName: string;
  email: string;
  jiraAccountId: string;
  days: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    env: 'staging',
    userId: '',
    name: '',
    displayName: '',
    actorType: '',
    clientName: '',
    email: '',
    jiraAccountId: '',
    days: 90,
  };

  for (let i = 0; i < args.length; i++) {
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
      case '--display-name':
        options.displayName = args[++i];
        break;
      case '--actor-type':
        options.actorType = args[++i] as 'human' | 'service';
        break;
      case '--client-name':
        options.clientName = args[++i];
        break;
      case '--email':
        options.email = args[++i];
        break;
      case '--jira-account-id':
        options.jiraAccountId = args[++i];
        break;
      case '--days':
        options.days = parseInt(args[++i], 10);
        break;
    }
  }

  return options;
}

function generateApiKey(): string {
  // Generate 32 bytes of random data, encode as base64url
  const randomData = randomBytes(32);
  const encoded = randomData
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${API_KEY_PREFIX}${encoded}`;
}

async function main() {
  const options = parseArgs();
  if (
    !options.userId ||
    !options.name ||
    !options.displayName ||
    (options.actorType !== 'human' && options.actorType !== 'service')
  ) {
    throw new Error('--user, --name, --display-name, and --actor-type (human or service) are required');
  }
  const tableName = `donatemate-${options.env}-mcp-api-keys-v2`;

  console.log('Generating API key...');
  console.log(`  Environment: ${options.env}`);
  console.log(`  Table: ${tableName}`);
  console.log(`  User ID: ${options.userId}`);
  console.log(`  Name: ${options.name}`);
  console.log(`  Actor: ${options.displayName} (${options.actorType})`);
  console.log(`  Client: ${options.clientName || options.name}`);
  console.log(`  Valid for: ${options.days} days`);

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 8); // First 8 chars for identification
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + options.days * 24 * 60 * 60;
  const expiresDate = new Date(expiresAt * 1000);

  const client = new DynamoDBClient({ region: 'us-east-2' });

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        keyHash: { S: keyHash },       // SHA-256 hash of the key (partition key)
        keyPrefix: { S: keyPrefix },   // First 8 chars for identification
        userId: { S: options.userId },
        name: { S: options.name },
        displayName: { S: options.displayName },
        actorType: { S: options.actorType },
        clientName: { S: options.clientName || options.name },
        email: { S: options.email || `${options.userId}@donatemate.com` },
        ...(options.jiraAccountId ? { jiraAccountId: { S: options.jiraAccountId } } : {}),
        createdAt: { S: now.toISOString() },
        expiresAt: { N: String(expiresAt) },
        revoked: { BOOL: false },
      },
    })
  );

  console.log('\n✅ API key generated successfully!\n');
  console.log('='.repeat(60));
  console.log('⚠️  SAVE THIS KEY - IT CANNOT BE RETRIEVED LATER ⚠️');
  console.log('='.repeat(60));
  console.log(`\n${apiKey}\n`);
  console.log('='.repeat(60));
  console.log(`Key ID: ${keyPrefix}...`);
  console.log(`Expires: ${expiresDate.toISOString()}`);
  console.log('='.repeat(60));

  console.log('\nUsage in Claude config:');
  console.log(JSON.stringify({
    mcpServers: {
      donatemate: {
        url: `https://na7zt9rxi7.execute-api.us-east-2.amazonaws.com/mcp`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    },
  }, null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
