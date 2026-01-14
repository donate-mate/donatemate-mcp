/**
 * Knowledge Base Indexer Handler
 *
 * Processes webhook events from SQS queue:
 * 1. Fetches content from the source integration
 * 2. Generates embeddings using AWS Bedrock Titan
 * 3. Stores content and embeddings in PostgreSQL with pgvector
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres, { Sql } from 'postgres';
import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const secretsClient = new SecretsManagerClient({});
const bedrockClient = new BedrockRuntimeClient({});

// Max file size to fetch (100KB)
const MAX_FILE_SIZE = 100 * 1024;

// Cache secrets in memory
const secretsCache: Map<string, { value: Record<string, string>; expiry: number }> = new Map();

// Database connection (reused across invocations)
let sql: Sql | null = null;

// Redis connection (lazy loaded)
let redisClient: any = null;
let redisLoadFailed = false;

interface WebhookEvent {
  source: 'github' | 'jira' | 'confluence' | 'slack';
  eventType: string;
  externalId: string;
  projectKey?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface ContentChunk {
  id: string;
  externalId: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  content: string;
  contentType: string;
  contentHash: string;
  chunkType: string;
  projectKey?: string;
  authorEmail?: string;
  authorName?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secret Management
// ---------------------------------------------------------------------------

async function getSecret(secretArn: string): Promise<Record<string, string>> {
  const cached = secretsCache.get(secretArn);
  if (cached && cached.expiry > Date.now()) {
    return cached.value;
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  const value = JSON.parse(response.SecretString || '{}');
  secretsCache.set(secretArn, {
    value,
    expiry: Date.now() + 5 * 60 * 1000, // 5 minute cache
  });

  return value;
}

// ---------------------------------------------------------------------------
// Database Connection
// ---------------------------------------------------------------------------

async function getDb(): Promise<Sql> {
  if (sql) return sql;

  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DATABASE_SECRET_ARN not configured');
  }

  const dbSecret = await getSecret(secretArn);

  sql = postgres({
    host: dbSecret.host,
    port: parseInt(dbSecret.port || '5432', 10),
    database: dbSecret.dbname || 'donatemate',
    username: dbSecret.username,
    password: dbSecret.password,
    ssl: 'prefer',
    max: 5,
    idle_timeout: 60,
  });

  return sql;
}

// ---------------------------------------------------------------------------
// Redis Connection (lazy loaded to avoid ESM issues)
// ---------------------------------------------------------------------------

async function getRedis(): Promise<any | null> {
  if (redisLoadFailed) return null;
  if (redisClient) return redisClient;

  const host = process.env.REDIS_HOST;
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);

  if (!host) {
    console.warn('REDIS_HOST not configured, skipping cache');
    redisLoadFailed = true;
    return null;
  }

  try {
    const { Redis } = await import('ioredis');
    redisClient = new Redis({
      host,
      port,
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true,
    });
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.warn('Redis connection failed, skipping cache', { error });
    redisLoadFailed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embedding Generation
// ---------------------------------------------------------------------------

async function generateEmbedding(text: string): Promise<number[]> {
  const cacheKey = `emb:${Buffer.from(text.slice(0, 1000)).toString('base64').slice(0, 100)}`;

  // Try to get from Redis cache
  const redis = await getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.warn('Redis cache read failed', { error });
    }
  }

  // Generate embedding using Bedrock Titan
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text.slice(0, 8192), // Titan limit
        dimensions: 1024,
        normalize: true,
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(response.body));
  const embedding = result.embedding as number[];

  // Cache in Redis (24 hour TTL)
  if (redis) {
    try {
      await redis.setex(cacheKey, 86400, JSON.stringify(embedding));
    } catch (error) {
      console.warn('Redis cache write failed', { error });
    }
  }

  return embedding;
}

// ---------------------------------------------------------------------------
// GitHub File Fetching
// ---------------------------------------------------------------------------

async function fetchGitHubFileContent(
  repoFullName: string,
  filePath: string
): Promise<{ content: string; sha: string } | null> {
  const secretArn = process.env.GITHUB_SECRET_ARN;
  if (!secretArn) {
    console.warn('GITHUB_SECRET_ARN not configured');
    return null;
  }

  const secrets = await getSecret(secretArn);
  const token = secrets.token;
  if (!token) {
    console.warn('GitHub token not found in secret');
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      console.warn('GitHub file fetch error', {
        repo: repoFullName,
        path: filePath,
        status: response.status,
      });
      return null;
    }

    const data = await response.json();

    // Skip if too large or not a file
    if (data.type !== 'file' || data.size > MAX_FILE_SIZE) {
      console.warn('File skipped - too large or not a file', {
        path: filePath,
        size: data.size,
        type: data.type,
      });
      return null;
    }

    // Content is base64 encoded
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha };
  } catch (error) {
    console.error('GitHub file fetch failed', {
      repo: repoFullName,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content Fetching
// ---------------------------------------------------------------------------

async function fetchContent(event: WebhookEvent): Promise<ContentChunk[]> {
  // For deleted events, return empty to trigger deletion
  if (event.eventType === 'deleted') {
    return [];
  }

  const now = new Date();
  // Use event timestamp for createdAt (actual message/event time), fallback to now
  const eventTime = event.timestamp ? new Date(event.timestamp) : now;

  // Handle GitHub file_changed events - fetch fresh content from GitHub
  if (event.source === 'github' && event.eventType === 'file_changed') {
    const filePath = event.payload.path as string;
    const repoFullName = event.projectKey;

    if (!filePath || !repoFullName) {
      console.warn('Missing path or repo for file_changed event');
      return [];
    }

    const fileData = await fetchGitHubFileContent(repoFullName, filePath);
    if (!fileData) {
      return [];
    }

    // Create event with fetched content
    const enrichedEvent: WebhookEvent = {
      ...event,
      eventType: 'file',
      payload: {
        path: filePath,
        content: fileData.content,
        sha: fileData.sha,
        type: filePath.endsWith('.md') ? 'markdown' :
              filePath.endsWith('.json') ? 'json' : 'text',
      },
    };

    const contentHash = Buffer.from(fileData.sha).toString('base64').slice(0, 32);

    const chunk: ContentChunk = {
      id: `${event.source}:${event.externalId}:${contentHash}`,
      externalId: event.externalId,
      sourceType: event.source,
      sourceUrl: buildSourceUrl(enrichedEvent),
      title: buildTitle(enrichedEvent),
      content: buildContent(enrichedEvent),
      contentType: 'text',
      contentHash,
      chunkType: getChunkType(enrichedEvent),
      projectKey: event.projectKey,
      createdAt: eventTime,
      updatedAt: now,
      metadata: enrichedEvent.payload,
    };

    return [chunk];
  }

  // Build a simple content chunk from the event payload
  const contentHash = Buffer.from(JSON.stringify(event.payload)).toString('base64').slice(0, 32);

  const chunk: ContentChunk = {
    id: `${event.source}:${event.externalId}:${contentHash}`,
    externalId: event.externalId,
    sourceType: event.source,
    sourceUrl: buildSourceUrl(event),
    title: buildTitle(event),
    content: buildContent(event),
    contentType: 'text',
    contentHash,
    chunkType: getChunkType(event),
    projectKey: event.projectKey,
    createdAt: eventTime,
    updatedAt: now,
    metadata: event.payload,
  };

  return [chunk];
}

function buildSourceUrl(event: WebhookEvent): string {
  switch (event.source) {
    case 'github':
      // For files, link to the specific file in the repo
      if (event.eventType === 'file' && event.payload.path) {
        return `https://github.com/${event.projectKey}/blob/main/${event.payload.path}`;
      }
      // For commits, link to the commit
      if (event.payload.sha) {
        return `https://github.com/${event.projectKey}/commit/${event.payload.sha}`;
      }
      return `https://github.com/${event.projectKey}`;
    case 'jira':
      return `https://donatemate.atlassian.net/browse/${event.externalId}`;
    case 'confluence':
      return `https://donatemate.atlassian.net/wiki/pages/${event.externalId}`;
    case 'slack':
      const [channel, ts] = event.externalId.split(':');
      return `https://donatemate.slack.com/archives/${channel}/p${ts?.replace('.', '')}`;
    default:
      return '';
  }
}

function buildTitle(event: WebhookEvent): string {
  const payload = event.payload;

  switch (event.source) {
    case 'github':
      // For files, use the file path as title
      if (event.eventType === 'file' && payload.path) {
        const fileName = (payload.path as string).split('/').pop() || payload.path;
        return `${event.projectKey}: ${fileName}`;
      }
      // For commits, use the commit message first line
      if (payload.message) {
        const firstLine = (payload.message as string).split('\n')[0];
        return firstLine.slice(0, 100);
      }
      return (payload.title as string) || `GitHub: ${event.externalId}`;
    case 'jira':
      return `${event.externalId}: ${payload.summary || 'Jira Issue'}`;
    case 'confluence':
      return (payload.title as string) || `Confluence: ${event.externalId}`;
    case 'slack': {
      const userName = (payload.userName as string) || (payload.user as string) || 'Unknown';
      return `Message from ${userName}`;
    }
    default:
      return event.externalId;
  }
}

function buildContent(event: WebhookEvent): string {
  const payload = event.payload;

  switch (event.source) {
    case 'github':
      // For files, use the actual file content
      if (event.eventType === 'file' && payload.content) {
        const header = [
          `# ${payload.path}`,
          `Repository: ${event.projectKey}`,
          `Type: ${payload.type || 'text'}`,
          '',
        ].join('\n');
        return header + (payload.content as string);
      }
      // For commits, format nicely
      if (payload.message) {
        return [
          `**Commit:** ${payload.sha}`,
          `**Author:** ${payload.author || 'Unknown'}`,
          `**Repository:** ${event.projectKey}`,
          '',
          (payload.message as string),
        ].join('\n');
      }
      return JSON.stringify(payload, null, 2);
    case 'jira':
      return [
        `**Issue:** ${event.externalId}`,
        `**Type:** ${payload.issueType || 'Unknown'}`,
        `**Status:** ${payload.status || 'Unknown'}`,
        `**Summary:** ${payload.summary || 'No summary'}`,
      ].join('\n');
    case 'confluence':
      return [
        `**Page:** ${payload.title || event.externalId}`,
        `**Version:** ${payload.version || 'Unknown'}`,
      ].join('\n');
    case 'slack': {
      const userName = (payload.userName as string) || (payload.user as string) || 'Unknown';
      const text = (payload.text as string) || 'Slack message';
      return `**From:** ${userName}\n\n${text}`;
    }
    default:
      return JSON.stringify(payload);
  }
}

function getChunkType(event: WebhookEvent): string {
  switch (event.source) {
    case 'github':
      if (event.eventType === 'file') {
        const path = event.payload.path as string;
        if (path?.toLowerCase().includes('readme')) return 'readme';
        if (path?.endsWith('.md')) return 'documentation';
        if (path?.endsWith('.json')) return 'config';
        return 'file';
      }
      if (event.eventType.includes('pull_request')) return 'pull_request';
      if (event.eventType.includes('issue')) return 'issue';
      return 'commit';
    case 'jira':
      return 'issue';
    case 'confluence':
      return 'page';
    case 'slack':
      return 'message';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Database Operations
// ---------------------------------------------------------------------------

async function upsertChunk(chunk: ContentChunk, embedding: number[]): Promise<void> {
  const db = await getDb();
  const embeddingStr = `[${embedding.join(',')}]`;

  await db`
    INSERT INTO knowledge_base (
      id, external_id, source_type, source_url, title, content,
      content_type, content_hash, chunk_type, project_key,
      author_email, author_name, created_at, updated_at,
      metadata, embedding
    ) VALUES (
      ${chunk.id}, ${chunk.externalId}, ${chunk.sourceType}, ${chunk.sourceUrl},
      ${chunk.title}, ${chunk.content}, ${chunk.contentType}, ${chunk.contentHash},
      ${chunk.chunkType}, ${chunk.projectKey || null},
      ${chunk.authorEmail || null}, ${chunk.authorName || null},
      ${chunk.createdAt}, ${chunk.updatedAt},
      ${JSON.stringify(chunk.metadata)}, ${db.unsafe(`'${embeddingStr}'::vector`)}
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      metadata = EXCLUDED.metadata,
      embedding = EXCLUDED.embedding
  `;
}

async function deleteChunk(externalId: string, sourceType: string): Promise<void> {
  const db = await getDb();

  await db`
    DELETE FROM knowledge_base
    WHERE external_id = ${externalId} AND source_type = ${sourceType}
  `;
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const webhookEvent: WebhookEvent = JSON.parse(record.body);

      console.info('Processing event', {
        source: webhookEvent.source,
        eventType: webhookEvent.eventType,
        externalId: webhookEvent.externalId,
      });

      // Handle deletion
      if (webhookEvent.eventType === 'deleted') {
        await deleteChunk(webhookEvent.externalId, webhookEvent.source);
        console.info('Deleted content', { externalId: webhookEvent.externalId });
        continue;
      }

      // Fetch content chunks
      const chunks = await fetchContent(webhookEvent);

      if (chunks.length === 0) {
        console.info('No content to index', { externalId: webhookEvent.externalId });
        continue;
      }

      // Process each chunk
      for (const chunk of chunks) {
        // Generate embedding
        const embedding = await generateEmbedding(chunk.content);

        // Store in database
        await upsertChunk(chunk, embedding);

        console.info('Indexed content', {
          id: chunk.id,
          sourceType: chunk.sourceType,
          title: chunk.title.slice(0, 50),
        });
      }
    } catch (error) {
      console.error('Failed to process record', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });

      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
}
