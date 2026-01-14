/**
 * Knowledge Base Search Handler
 *
 * Provides hybrid search (vector + full-text) for the knowledge base.
 * Called by MCP tools to find relevant context for AI queries.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres, { Sql } from 'postgres';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});
const bedrockClient = new BedrockRuntimeClient({});

// Cache secrets in memory
const secretsCache: Map<string, { value: Record<string, string>; expiry: number }> = new Map();

// Database connection
let sql: Sql | null = null;

// Redis connection (lazy loaded)
let redisClient: any = null;
let redisLoadFailed = false;

interface SearchQuery {
  query: string;
  filters?: {
    sourceTypes?: string[];
    projectKeys?: string[];
    chunkTypes?: string[];
    dateRange?: {
      start?: string;
      end?: string;
    };
  };
  limit?: number;
  offset?: number;
  includeContent?: boolean;
}

interface SearchResult {
  id: string;
  externalId: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  content?: string;
  contentSnippet: string;
  chunkType: string;
  projectKey?: string;
  authorName?: string;
  createdAt: string;
  updatedAt: string;
  score: number;
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
    expiry: Date.now() + 5 * 60 * 1000,
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

async function generateQueryEmbedding(text: string): Promise<number[]> {
  const cacheKey = `qemb:${Buffer.from(text).toString('base64').slice(0, 100)}`;

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

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text.slice(0, 8192),
        dimensions: 1024,
        normalize: true,
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(response.body));
  const embedding = result.embedding as number[];

  // Cache for 1 hour (queries are often repeated)
  if (redis) {
    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(embedding));
    } catch (error) {
      console.warn('Redis cache write failed', { error });
    }
  }

  return embedding;
}

// ---------------------------------------------------------------------------
// Hybrid Search
// ---------------------------------------------------------------------------

async function hybridSearch(
  query: SearchQuery,
  queryEmbedding: number[]
): Promise<SearchResult[]> {
  const db = await getDb();
  const limit = Math.min(query.limit || 20, 100);
  const offset = query.offset || 0;
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Build dynamic filters
  const sourceTypes = query.filters?.sourceTypes || [];
  const projectKeys = query.filters?.projectKeys || [];
  const chunkTypes = query.filters?.chunkTypes || [];
  const startDate = query.filters?.dateRange?.start || null;
  const endDate = query.filters?.dateRange?.end || null;

  // Use raw SQL with postgres.js for complex hybrid query
  const results = await db.unsafe(`
    WITH vector_results AS (
      SELECT
        id,
        1 - (embedding <=> '${embeddingStr}'::vector) AS vector_score
      FROM knowledge_base
      WHERE 1=1
        ${sourceTypes.length > 0 ? `AND source_type = ANY(ARRAY['${sourceTypes.join("','")}'])` : ''}
        ${projectKeys.length > 0 ? `AND project_key = ANY(ARRAY['${projectKeys.join("','")}'])` : ''}
        ${chunkTypes.length > 0 ? `AND chunk_type = ANY(ARRAY['${chunkTypes.join("','")}'])` : ''}
        ${startDate ? `AND created_at >= '${startDate}'::timestamptz` : ''}
        ${endDate ? `AND created_at <= '${endDate}'::timestamptz` : ''}
      ORDER BY embedding <=> '${embeddingStr}'::vector
      LIMIT ${limit * 2}
    ),
    text_results AS (
      SELECT
        id,
        ts_rank(
          to_tsvector('english', coalesce(title, '') || ' ' || content),
          plainto_tsquery('english', $1)
        ) AS text_score
      FROM knowledge_base
      WHERE to_tsvector('english', coalesce(title, '') || ' ' || content) @@ plainto_tsquery('english', $1)
        ${sourceTypes.length > 0 ? `AND source_type = ANY(ARRAY['${sourceTypes.join("','")}'])` : ''}
        ${projectKeys.length > 0 ? `AND project_key = ANY(ARRAY['${projectKeys.join("','")}'])` : ''}
        ${chunkTypes.length > 0 ? `AND chunk_type = ANY(ARRAY['${chunkTypes.join("','")}'])` : ''}
        ${startDate ? `AND created_at >= '${startDate}'::timestamptz` : ''}
        ${endDate ? `AND created_at <= '${endDate}'::timestamptz` : ''}
      LIMIT ${limit * 2}
    ),
    combined AS (
      SELECT
        COALESCE(v.id, t.id) AS id,
        COALESCE(v.vector_score, 0) * 0.7 + COALESCE(t.text_score, 0) * 0.3 AS combined_score
      FROM vector_results v
      FULL OUTER JOIN text_results t ON v.id = t.id
    )
    SELECT
      kb.id,
      kb.external_id,
      kb.source_type,
      kb.source_url,
      kb.title,
      ${query.includeContent ? 'kb.content,' : ''}
      LEFT(kb.content, 300) AS content_snippet,
      kb.chunk_type,
      kb.project_key,
      kb.author_name,
      kb.created_at,
      kb.updated_at,
      c.combined_score AS score,
      kb.metadata
    FROM combined c
    JOIN knowledge_base kb ON c.id = kb.id
    ORDER BY c.combined_score DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `, [query.query]);

  return results.map((row: any) => ({
    id: row.id,
    externalId: row.external_id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    title: row.title,
    content: row.content,
    contentSnippet: row.content_snippet,
    chunkType: row.chunk_type,
    projectKey: row.project_key,
    authorName: row.author_name,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    score: parseFloat(row.score) || 0,
    metadata: row.metadata || {},
  }));
}

// ---------------------------------------------------------------------------
// Stats Query
// ---------------------------------------------------------------------------

async function getStats(): Promise<Record<string, unknown>> {
  const db = await getDb();

  const result = await db`
    SELECT
      source_type,
      COUNT(*) AS count,
      MAX(updated_at) AS last_updated
    FROM knowledge_base
    GROUP BY source_type
    ORDER BY source_type
  `;

  const bySource: Record<string, { count: number; lastUpdated: string }> = {};
  let total = 0;

  for (const row of result) {
    bySource[row.source_type] = {
      count: parseInt(row.count as string, 10),
      lastUpdated: row.last_updated?.toISOString?.() || row.last_updated,
    };
    total += parseInt(row.count as string, 10);
  }

  return {
    total,
    bySource,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

// Support both API Gateway v2 events and Lambda-to-Lambda invocations
interface LambdaInvokeEvent {
  httpMethod?: string;
  path?: string;
  body?: string;
}

export async function handler(
  event: APIGatewayProxyEventV2 | LambdaInvokeEvent
): Promise<APIGatewayProxyResultV2> {
  // Handle Lambda-to-Lambda invocation (simpler event format)
  const isLambdaInvoke = !('requestContext' in event);
  const method = isLambdaInvoke
    ? (event as LambdaInvokeEvent).httpMethod || 'GET'
    : (event as APIGatewayProxyEventV2).requestContext.http.method;
  const path = isLambdaInvoke
    ? (event as LambdaInvokeEvent).path || '/stats'
    : (event as APIGatewayProxyEventV2).rawPath;
  const eventBody = isLambdaInvoke
    ? (event as LambdaInvokeEvent).body
    : (event as APIGatewayProxyEventV2).body;

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    // Health check
    if (path === '/health' && method === 'GET') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'healthy' }),
      };
    }

    // Stats endpoint
    if (path === '/stats' && method === 'GET') {
      const stats = await getStats();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(stats),
      };
    }

    // Search endpoint
    if (path === '/search' && method === 'POST') {
      const body = JSON.parse(eventBody || '{}') as SearchQuery;

      if (!body.query || body.query.trim().length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Query is required' }),
        };
      }

      console.info('Search request', {
        query: body.query.slice(0, 100),
        filters: body.filters,
        limit: body.limit,
      });

      // Generate query embedding
      const queryEmbedding = await generateQueryEmbedding(body.query);

      // Perform hybrid search
      const results = await hybridSearch(body, queryEmbedding);

      console.info('Search completed', {
        query: body.query.slice(0, 50),
        resultCount: results.length,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results,
          query: body.query,
          total: results.length,
        }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Search handler error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
