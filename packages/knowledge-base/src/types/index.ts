/**
 * Core types for the DonateMate Knowledge Base system
 * All integrations implement these interfaces for consistency
 */

import { z } from 'zod';

// =============================================================================
// Source Types
// =============================================================================

export type SourceType =
  | 'github'
  | 'jira'
  | 'confluence'
  | 'slack'
  | 'figma'
  | 'linear'
  | 'notion';

export type ContentType = 'text' | 'code' | 'markdown' | 'html';

export type ChunkType =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'component'
  | 'module'
  | 'file'
  | 'issue'
  | 'page'
  | 'message'
  | 'thread'
  | 'comment';

// =============================================================================
// Content Chunk - Universal format for all sources
// =============================================================================

export interface ContentChunk {
  /** Unique identifier: source:externalId:hash */
  id: string;

  /** External system identifier */
  externalId: string;

  /** Source integration type */
  sourceType: SourceType;

  /** Direct URL to source */
  sourceUrl: string;

  /** Title or summary */
  title: string;

  /** Main content */
  content: string;

  /** Content format */
  contentType: ContentType;

  /** Semantic chunk type */
  chunkType: ChunkType;

  /** SHA-256 hash of content for deduplication */
  contentHash: string;

  /** Hierarchy */
  parentId?: string;
  projectKey?: string;

  /** For code: symbols referenced/defined */
  symbols?: string[];

  /** For code: language */
  language?: string;

  /** For code: file path */
  filePath?: string;

  /** For code: line range */
  startLine?: number;
  endLine?: number;

  /** For git: branch name */
  branch?: string;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;

  /** Author info */
  authorEmail?: string;
  authorName?: string;

  /** Flexible metadata per source */
  metadata: Record<string, unknown>;
}

// =============================================================================
// Integration Events
// =============================================================================

export type EventType = 'created' | 'updated' | 'deleted';

export interface IntegrationEvent {
  /** Event type */
  eventType: EventType;

  /** External system ID */
  externalId: string;

  /** Source type */
  sourceType: SourceType;

  /** When the event occurred */
  timestamp: Date;

  /** Project/repo/space key */
  projectKey?: string;

  /** Branch (for git sources) */
  branch?: string;

  /** Raw payload from webhook */
  payload?: unknown;
}

// =============================================================================
// Integration Plugin Interface
// =============================================================================

export interface IntegrationConfig {
  /** Integration identifier */
  id: string;

  /** Whether enabled */
  enabled: boolean;

  /** Plugin package name */
  plugin: string;

  /** Plugin-specific configuration */
  config: Record<string, unknown>;

  /** Sync settings */
  sync?: {
    schedule?: string;
    batchSize?: number;
  };
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string | Record<string, unknown>;
  signature?: string;
}

export interface SyncState {
  integrationId: string;
  cursor?: string;
  lastSync: Date;
  status: 'idle' | 'running' | 'error';
  error?: string;
  itemsIndexed: number;
}

export interface ExternalReference {
  type: SourceType;
  identifier: string;
  context?: string;
}

/**
 * Universal interface for ALL integration plugins
 * New sources just implement this interface
 */
export interface IntegrationPlugin {
  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /** Unique integration identifier */
  readonly id: SourceType;

  /** Human-readable name */
  readonly name: string;

  /** Plugin version */
  readonly version: string;

  /** JSON Schema for configuration validation */
  readonly configSchema: z.ZodSchema;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Initialize the plugin with configuration */
  initialize(config: IntegrationConfig): Promise<void>;

  /** Check if the integration is healthy */
  healthCheck(): Promise<HealthStatus>;

  /** Clean up resources */
  shutdown(): Promise<void>;

  // -------------------------------------------------------------------------
  // Webhook Handling
  // -------------------------------------------------------------------------

  /** Validate webhook signature/authenticity */
  validateWebhook(request: WebhookRequest): Promise<boolean>;

  /** Parse webhook into integration events */
  parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]>;

  // -------------------------------------------------------------------------
  // Content Extraction
  // -------------------------------------------------------------------------

  /** Fetch a single item by external ID */
  fetchItem(externalId: string, options?: { branch?: string }): Promise<ContentChunk[]>;

  // -------------------------------------------------------------------------
  // Sync Operations
  // -------------------------------------------------------------------------

  /** List all items for initial sync (paginated) */
  listItems(cursor?: string): AsyncGenerator<ContentChunk[], void, undefined>;

  /** Get changes since a date (incremental sync) */
  getChanges(since: Date): AsyncGenerator<IntegrationEvent[], void, undefined>;

  // -------------------------------------------------------------------------
  // Cross-Reference
  // -------------------------------------------------------------------------

  /** Extract references to other sources from content */
  extractReferences(content: string): ExternalReference[];

  /** Resolve an external reference to an internal ID */
  resolveReference(ref: ExternalReference): Promise<string | null>;
}

// =============================================================================
// Database Models
// =============================================================================

export interface KnowledgeBaseRecord {
  id: string;
  source_type: SourceType;
  source_id: string;
  source_url: string;
  title: string;
  content: string;
  content_hash: string;
  content_type: ContentType;
  chunk_type: ChunkType;
  parent_id?: string;
  project_key?: string;
  branch?: string;
  file_path?: string;
  language?: string;
  symbols?: string[];
  start_line?: number;
  end_line?: number;
  author_email?: string;
  author_name?: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeLinkRecord {
  id: number;
  source_id: string;
  target_id: string;
  link_type: 'mentions' | 'implements' | 'relates_to' | 'blocks' | 'parent_of';
  created_at: Date;
}

// =============================================================================
// Search Types
// =============================================================================

export interface SearchQuery {
  /** Natural language query */
  query: string;

  /** Sources to search */
  sources?: SourceType[];

  /** Project/repo/space filter */
  projectKey?: string;

  /** Branch filter (for code) */
  branch?: string;

  /** Author filter */
  authorEmail?: string;

  /** Date range */
  dateFrom?: Date;
  dateTo?: Date;

  /** Chunk type filter */
  chunkTypes?: ChunkType[];

  /** Max results */
  limit?: number;

  /** Search mode */
  mode?: 'semantic' | 'keyword' | 'hybrid';
}

export interface SearchResult {
  /** Matching chunk */
  chunk: ContentChunk;

  /** Relevance score (0-1) */
  score: number;

  /** How the match was found */
  matchType: 'vector' | 'keyword' | 'hybrid';

  /** Highlighted snippets */
  highlights?: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  query: SearchQuery;
  executionTimeMs: number;
}
