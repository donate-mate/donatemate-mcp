/**
 * Base Plugin - Abstract base class for integration plugins
 * Provides common functionality and utilities
 */

import { createHash } from 'crypto';
import type {
  IntegrationPlugin,
  IntegrationConfig,
  HealthStatus,
  WebhookRequest,
  IntegrationEvent,
  ContentChunk,
  ExternalReference,
  SourceType,
} from '../../types/index.js';
import { z } from 'zod';

export abstract class BasePlugin implements IntegrationPlugin {
  abstract readonly id: SourceType;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly configSchema: z.ZodSchema;

  protected config: IntegrationConfig | null = null;
  protected isInitialized = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(config: IntegrationConfig): Promise<void> {
    this.config = config;
    await this.onInitialize(config);
    this.isInitialized = true;
  }

  /**
   * Override in subclass for custom initialization
   */
  protected abstract onInitialize(config: IntegrationConfig): Promise<void>;

  abstract healthCheck(): Promise<HealthStatus>;

  async shutdown(): Promise<void> {
    await this.onShutdown();
    this.isInitialized = false;
    this.config = null;
  }

  /**
   * Override in subclass for custom cleanup
   */
  protected async onShutdown(): Promise<void> {
    // Default: no-op
  }

  // -------------------------------------------------------------------------
  // Webhook Handling
  // -------------------------------------------------------------------------

  abstract validateWebhook(request: WebhookRequest): Promise<boolean>;
  abstract parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]>;

  // -------------------------------------------------------------------------
  // Content Extraction
  // -------------------------------------------------------------------------

  abstract fetchItem(
    externalId: string,
    options?: { branch?: string }
  ): Promise<ContentChunk[]>;

  // -------------------------------------------------------------------------
  // Sync Operations
  // -------------------------------------------------------------------------

  abstract listItems(
    cursor?: string
  ): AsyncGenerator<ContentChunk[], void, undefined>;

  abstract getChanges(
    since: Date
  ): AsyncGenerator<IntegrationEvent[], void, undefined>;

  // -------------------------------------------------------------------------
  // Cross-Reference
  // -------------------------------------------------------------------------

  abstract extractReferences(content: string): ExternalReference[];

  abstract resolveReference(ref: ExternalReference): Promise<string | null>;

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Generate a content hash for deduplication
   */
  protected hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Generate a unique ID for a chunk
   */
  protected generateChunkId(
    externalId: string,
    contentHash: string
  ): string {
    return `${this.id}:${externalId}:${contentHash.substring(0, 8)}`;
  }

  /**
   * Ensure plugin is initialized before operations
   */
  protected ensureInitialized(): void {
    if (!this.isInitialized || !this.config) {
      throw new Error(`Plugin ${this.id} is not initialized`);
    }
  }

  /**
   * Get configuration value with type safety
   */
  protected getConfigValue<T>(key: string, defaultValue?: T): T {
    this.ensureInitialized();
    const value = (this.config!.config as Record<string, unknown>)[key];
    return (value as T) ?? defaultValue!;
  }

  /**
   * Log with plugin context
   */
  protected log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const prefix = `[${this.id}]`;
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(prefix, message, data ?? '');
  }
}
