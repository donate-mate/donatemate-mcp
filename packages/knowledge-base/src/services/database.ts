/**
 * Database Service - PostgreSQL with pgvector for knowledge storage
 * Using postgres.js (ESM-native PostgreSQL client)
 */

import postgres, { Sql } from 'postgres';
import type {
  ContentChunk,
  KnowledgeBaseRecord,
  KnowledgeLinkRecord,
  SearchQuery,
  SearchResult,
  SyncState,
  SourceType,
} from '../types/index.js';

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
}

export class DatabaseService {
  private sql: Sql;

  constructor(config: DatabaseConfig) {
    this.sql = postgres({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password: config.password,
      ssl: config.ssl ? 'prefer' : false,
      max: config.maxConnections ?? 10,
    });
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    // Enable pgvector extension
    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;

    // Create knowledge_base table
    await this.sql`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        chunk_type TEXT,
        parent_id TEXT,
        project_key TEXT,
        branch TEXT,
        file_path TEXT,
        language TEXT,
        symbols TEXT[],
        start_line INTEGER,
        end_line INTEGER,
        author_email TEXT,
        author_name TEXT,
        metadata JSONB DEFAULT '{}',
        embedding vector(1024),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),

        CONSTRAINT unique_source UNIQUE (source_type, source_id, content_hash)
      )
    `;

    // Create indexes
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_source_type ON knowledge_base(source_type)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_project ON knowledge_base(project_key)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_branch ON knowledge_base(branch)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_author ON knowledge_base(author_email)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_updated ON knowledge_base(updated_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kb_content_hash ON knowledge_base(content_hash)`;

    // Create full-text search index
    await this.sql`
      ALTER TABLE knowledge_base
      ADD COLUMN IF NOT EXISTS content_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', content), 'B')
      ) STORED
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_kb_content_fts
      ON knowledge_base USING GIN(content_tsv)
    `;

    // Create knowledge_links table
    await this.sql`
      CREATE TABLE IF NOT EXISTS knowledge_links (
        id SERIAL PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),

        CONSTRAINT unique_link UNIQUE (source_id, target_id, link_type)
      )
    `;

    await this.sql`CREATE INDEX IF NOT EXISTS idx_kl_source ON knowledge_links(source_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_kl_target ON knowledge_links(target_id)`;

    // Create sync_state table
    await this.sql`
      CREATE TABLE IF NOT EXISTS knowledge_sync_state (
        integration_id TEXT PRIMARY KEY,
        cursor TEXT,
        last_sync TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'idle',
        error TEXT,
        items_indexed INTEGER DEFAULT 0
      )
    `;

    console.log('[DatabaseService] Schema initialized');
  }

  /**
   * Upsert a content chunk
   */
  async upsertChunk(chunk: ContentChunk, embedding?: number[]): Promise<void> {
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    await this.sql`
      INSERT INTO knowledge_base (
        id, source_type, source_id, source_url, title, content, content_hash,
        content_type, chunk_type, parent_id, project_key, branch, file_path,
        language, symbols, start_line, end_line, author_email, author_name,
        metadata, embedding, created_at, updated_at
      ) VALUES (
        ${chunk.id}, ${chunk.sourceType}, ${chunk.externalId}, ${chunk.sourceUrl},
        ${chunk.title}, ${chunk.content}, ${chunk.contentHash}, ${chunk.contentType},
        ${chunk.chunkType}, ${chunk.parentId || null}, ${chunk.projectKey || null},
        ${chunk.branch || null}, ${chunk.filePath || null}, ${chunk.language || null},
        ${chunk.symbols || null}, ${chunk.startLine || null}, ${chunk.endLine || null},
        ${chunk.authorEmail || null}, ${chunk.authorName || null},
        ${JSON.stringify(chunk.metadata || {})}, ${embeddingStr}::vector,
        ${chunk.createdAt}, ${chunk.updatedAt}
      )
      ON CONFLICT (source_type, source_id, content_hash) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        source_url = EXCLUDED.source_url,
        chunk_type = EXCLUDED.chunk_type,
        parent_id = EXCLUDED.parent_id,
        project_key = EXCLUDED.project_key,
        branch = EXCLUDED.branch,
        file_path = EXCLUDED.file_path,
        language = EXCLUDED.language,
        symbols = EXCLUDED.symbols,
        start_line = EXCLUDED.start_line,
        end_line = EXCLUDED.end_line,
        author_email = EXCLUDED.author_email,
        author_name = EXCLUDED.author_name,
        metadata = EXCLUDED.metadata,
        embedding = EXCLUDED.embedding,
        updated_at = NOW()
    `;
  }

  /**
   * Batch upsert chunks
   */
  async upsertChunks(
    chunks: Array<{ chunk: ContentChunk; embedding?: number[] }>
  ): Promise<void> {
    await this.sql.begin(async (sql) => {
      for (const { chunk, embedding } of chunks) {
        await this.upsertChunk(chunk, embedding);
      }
    });
  }

  /**
   * Delete a chunk by ID
   */
  async deleteChunk(id: string): Promise<void> {
    await this.sql`DELETE FROM knowledge_base WHERE id = ${id}`;
  }

  /**
   * Delete chunks by source type and external ID
   */
  async deleteBySourceId(sourceType: SourceType, sourceId: string): Promise<void> {
    await this.sql`
      DELETE FROM knowledge_base
      WHERE source_type = ${sourceType} AND source_id = ${sourceId}
    `;
  }

  /**
   * Get chunk by ID
   */
  async getChunk(id: string): Promise<KnowledgeBaseRecord | null> {
    const result = await this.sql<KnowledgeBaseRecord[]>`
      SELECT * FROM knowledge_base WHERE id = ${id}
    `;
    return result[0] ?? null;
  }

  /**
   * Check if content already exists (by hash)
   */
  async contentExists(contentHash: string): Promise<boolean> {
    const result = await this.sql`
      SELECT 1 FROM knowledge_base WHERE content_hash = ${contentHash} LIMIT 1
    `;
    return result.length > 0;
  }

  /**
   * Hybrid search (vector + full-text)
   */
  async search(
    query: SearchQuery,
    queryEmbedding?: number[]
  ): Promise<SearchResult[]> {
    const limit = query.limit ?? 20;
    const mode = query.mode ?? 'hybrid';
    const hasEmbedding = queryEmbedding && queryEmbedding.length > 0;
    const embeddingStr = hasEmbedding ? `[${queryEmbedding.join(',')}]` : null;

    let results: KnowledgeBaseRecord[];

    if (mode === 'semantic' && hasEmbedding) {
      // Pure vector search
      results = await this.sql<KnowledgeBaseRecord[]>`
        SELECT *,
               1 - (embedding <=> ${embeddingStr}::vector) as score,
               'vector' as match_type
        FROM knowledge_base
        WHERE ${this.buildWhereConditions(query)}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
      `;
    } else if (mode === 'keyword') {
      // Pure full-text search
      results = await this.sql<KnowledgeBaseRecord[]>`
        SELECT *,
               ts_rank(content_tsv, plainto_tsquery(${query.query})) as score,
               'keyword' as match_type
        FROM knowledge_base
        WHERE content_tsv @@ plainto_tsquery(${query.query})
          ${this.buildFilterConditions(query)}
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    } else {
      // Hybrid search
      if (hasEmbedding) {
        results = await this.sql<KnowledgeBaseRecord[]>`
          WITH text_results AS (
            SELECT id,
                   ts_rank(content_tsv, plainto_tsquery(${query.query})) as text_score
            FROM knowledge_base
            WHERE content_tsv @@ plainto_tsquery(${query.query})
            ${this.buildFilterConditions(query)}
          ),
          vector_results AS (
            SELECT id,
                   1 - (embedding <=> ${embeddingStr}::vector) as vector_score
            FROM knowledge_base
            ${query.sources?.length || query.projectKey ? 'WHERE ' : ''}
            ${this.buildWhereConditions(query)}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT 100
          )
          SELECT kb.*,
                 COALESCE(tr.text_score, 0) * 0.3 + COALESCE(vr.vector_score, 0) * 0.7 as score,
                 CASE
                   WHEN tr.id IS NOT NULL AND vr.id IS NOT NULL THEN 'hybrid'
                   WHEN vr.id IS NOT NULL THEN 'vector'
                   ELSE 'keyword'
                 END as match_type
          FROM knowledge_base kb
          LEFT JOIN text_results tr ON kb.id = tr.id
          LEFT JOIN vector_results vr ON kb.id = vr.id
          WHERE tr.id IS NOT NULL OR vr.id IS NOT NULL
          ORDER BY score DESC
          LIMIT ${limit}
        `;
      } else {
        // No embedding, fall back to keyword search
        results = await this.sql<KnowledgeBaseRecord[]>`
          SELECT *,
                 ts_rank(content_tsv, plainto_tsquery(${query.query})) as score,
                 'keyword' as match_type
          FROM knowledge_base
          WHERE content_tsv @@ plainto_tsquery(${query.query})
            ${this.buildFilterConditions(query)}
          ORDER BY score DESC
          LIMIT ${limit}
        `;
      }
    }

    return results.map((row: any) => ({
      chunk: this.recordToChunk(row),
      score: parseFloat(row.score),
      matchType: row.match_type,
    }));
  }

  private buildWhereConditions(query: SearchQuery): ReturnType<typeof this.sql.unsafe> {
    const conditions: string[] = [];

    if (query.sources && query.sources.length > 0) {
      conditions.push(`source_type = ANY(ARRAY['${query.sources.join("','")}'])`);
    }
    if (query.projectKey) {
      conditions.push(`project_key = '${query.projectKey}'`);
    }
    if (query.branch) {
      conditions.push(`branch = '${query.branch}'`);
    }
    if (query.authorEmail) {
      conditions.push(`author_email = '${query.authorEmail}'`);
    }

    return this.sql.unsafe(conditions.length > 0 ? conditions.join(' AND ') : '1=1');
  }

  private buildFilterConditions(query: SearchQuery): ReturnType<typeof this.sql.unsafe> {
    const conditions: string[] = [];

    if (query.sources && query.sources.length > 0) {
      conditions.push(`AND source_type = ANY(ARRAY['${query.sources.join("','")}'])`);
    }
    if (query.projectKey) {
      conditions.push(`AND project_key = '${query.projectKey}'`);
    }

    return this.sql.unsafe(conditions.join(' '));
  }

  /**
   * Get related chunks via links
   */
  async getRelated(id: string, limit = 10): Promise<ContentChunk[]> {
    const result = await this.sql<KnowledgeBaseRecord[]>`
      SELECT kb.* FROM knowledge_base kb
      JOIN knowledge_links kl ON kb.id = kl.target_id OR kb.id = kl.source_id
      WHERE (kl.source_id = ${id} OR kl.target_id = ${id}) AND kb.id != ${id}
      LIMIT ${limit}
    `;

    return result.map((row) => this.recordToChunk(row));
  }

  /**
   * Add a link between chunks
   */
  async addLink(
    sourceId: string,
    targetId: string,
    linkType: KnowledgeLinkRecord['link_type']
  ): Promise<void> {
    await this.sql`
      INSERT INTO knowledge_links (source_id, target_id, link_type)
      VALUES (${sourceId}, ${targetId}, ${linkType})
      ON CONFLICT (source_id, target_id, link_type) DO NOTHING
    `;
  }

  /**
   * Get sync state for an integration
   */
  async getSyncState(integrationId: string): Promise<SyncState | null> {
    const result = await this.sql<any[]>`
      SELECT * FROM knowledge_sync_state WHERE integration_id = ${integrationId}
    `;

    if (result.length === 0) return null;

    const row = result[0];
    return {
      integrationId: row.integration_id,
      cursor: row.cursor,
      lastSync: row.last_sync,
      status: row.status,
      error: row.error,
      itemsIndexed: row.items_indexed,
    };
  }

  /**
   * Update sync state
   */
  async updateSyncState(state: Partial<SyncState> & { integrationId: string }): Promise<void> {
    await this.sql`
      INSERT INTO knowledge_sync_state (integration_id, cursor, last_sync, status, error, items_indexed)
      VALUES (
        ${state.integrationId},
        ${state.cursor || null},
        ${state.lastSync ?? new Date()},
        ${state.status ?? 'idle'},
        ${state.error || null},
        ${state.itemsIndexed ?? 0}
      )
      ON CONFLICT (integration_id) DO UPDATE SET
        cursor = COALESCE(EXCLUDED.cursor, knowledge_sync_state.cursor),
        last_sync = COALESCE(EXCLUDED.last_sync, knowledge_sync_state.last_sync),
        status = COALESCE(EXCLUDED.status, knowledge_sync_state.status),
        error = EXCLUDED.error,
        items_indexed = COALESCE(EXCLUDED.items_indexed, knowledge_sync_state.items_indexed)
    `;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<Record<string, number>> {
    const result = await this.sql<{ source_type: string; count: string }[]>`
      SELECT source_type, COUNT(*) as count
      FROM knowledge_base
      GROUP BY source_type
    `;

    return result.reduce((acc, row) => {
      acc[row.source_type] = parseInt(row.count, 10);
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    await this.sql.end();
  }

  /**
   * Convert database record to ContentChunk
   */
  private recordToChunk(row: KnowledgeBaseRecord): ContentChunk {
    return {
      id: row.id,
      externalId: row.source_id,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      title: row.title,
      content: row.content,
      contentHash: row.content_hash,
      contentType: row.content_type,
      chunkType: row.chunk_type,
      parentId: row.parent_id,
      projectKey: row.project_key,
      branch: row.branch,
      filePath: row.file_path,
      language: row.language,
      symbols: row.symbols,
      startLine: row.start_line,
      endLine: row.end_line,
      authorEmail: row.author_email,
      authorName: row.author_name,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
