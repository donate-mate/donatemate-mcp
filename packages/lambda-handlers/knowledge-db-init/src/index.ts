/**
 * Knowledge Base Database Initializer
 *
 * Custom resource handler that:
 * 1. Enables pgvector extension
 * 2. Creates the knowledge base schema (tables, indexes)
 *
 * This runs on stack creation/update.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});

interface DatabaseSecret {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

// SQL migration - creates schema with pgvector support
const MIGRATION_SQL = `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Main knowledge base table
CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    content_hash TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    parent_id TEXT REFERENCES knowledge_base(id) ON DELETE CASCADE,
    project_key TEXT,
    author_email TEXT,
    author_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    embedding vector(1024),

    -- Unique constraint on external_id + source_type
    CONSTRAINT knowledge_base_external_unique UNIQUE (external_id, source_type)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_knowledge_source_type ON knowledge_base(source_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_project_key ON knowledge_base(project_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_type ON knowledge_base(chunk_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_base(created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_updated_at ON knowledge_base(updated_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_content_hash ON knowledge_base(content_hash);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_knowledge_fts ON knowledge_base
    USING GIN (to_tsvector('english', title || ' ' || content));

-- Vector similarity index (IVFFlat for better performance on larger datasets)
-- Note: Requires some data before creating, so we use a conditional approach
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM knowledge_base LIMIT 1) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_embedding') THEN
            CREATE INDEX idx_knowledge_embedding ON knowledge_base
                USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
        END IF;
    END IF;
END $$;

-- Knowledge links table (cross-references between items)
CREATE TABLE IF NOT EXISTS knowledge_links (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL, -- 'reference', 'related', 'parent', 'duplicate'
    confidence FLOAT DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',

    CONSTRAINT knowledge_links_unique UNIQUE (source_id, target_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(target_id);

-- Sync state table (tracks last sync for each integration)
CREATE TABLE IF NOT EXISTS knowledge_sync_state (
    integration_id TEXT PRIMARY KEY,
    integration_type TEXT NOT NULL,
    last_sync_at TIMESTAMPTZ,
    last_successful_sync_at TIMESTAMPTZ,
    sync_cursor TEXT, -- For pagination/incremental sync
    items_synced INTEGER DEFAULT 0,
    items_failed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'idle', -- 'idle', 'running', 'failed'
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for auto-updating timestamps
DROP TRIGGER IF EXISTS update_knowledge_base_updated_at ON knowledge_base;
CREATE TRIGGER update_knowledge_base_updated_at
    BEFORE UPDATE ON knowledge_base
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_knowledge_sync_state_updated_at ON knowledge_sync_state;
CREATE TRIGGER update_knowledge_sync_state_updated_at
    BEFORE UPDATE ON knowledge_sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
`;

async function getDbCredentials(): Promise<DatabaseSecret> {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DATABASE_SECRET_ARN environment variable not set');
  }

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!result.SecretString) {
    throw new Error('Database secret has no value');
  }

  return JSON.parse(result.SecretString);
}

async function runMigration(): Promise<string> {
  const credentials = await getDbCredentials();

  // Use postgres.js (ESM-native)
  const sql = postgres({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: 'prefer',
    connect_timeout: 30,
  });

  try {
    console.log('Connecting to database...');

    // Test connection
    await sql`SELECT 1`;
    console.log('Connected successfully');

    console.log('Running migration...');
    await sql.unsafe(MIGRATION_SQL);

    console.log('Migration completed successfully');
    return 'Migration completed successfully';
  } finally {
    await sql.end();
  }
}

export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const response: CloudFormationCustomResourceResponse = {
    Status: 'SUCCESS',
    PhysicalResourceId: event.PhysicalResourceId || 'knowledge-db-init',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  };

  try {
    switch (event.RequestType) {
      case 'Create':
      case 'Update':
        const result = await runMigration();
        response.Data = { Message: result };
        break;

      case 'Delete':
        // Don't drop tables on delete - data should be preserved
        console.log('Delete request - no action taken (preserving data)');
        response.Data = { Message: 'No action taken on delete' };
        break;
    }
  } catch (error) {
    console.error('Migration error:', error);
    response.Status = 'FAILED';
    response.Reason =
      error instanceof Error ? error.message : 'Unknown error occurred';
  }

  return response;
}
