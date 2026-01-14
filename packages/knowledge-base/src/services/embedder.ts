/**
 * Embedder Service - AWS Bedrock Titan for embeddings with caching
 *
 * Features:
 * - Automatic batching of embedding requests
 * - Redis caching with 30-day TTL
 * - Rate limiting to prevent Bedrock throttling (10 concurrent requests)
 * - Retry with exponential backoff for transient errors
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ThrottlingException,
  ServiceUnavailableException,
} from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'crypto';
import { Redis } from 'ioredis';

export interface EmbedderConfig {
  region?: string;
  modelId?: string;
  dimensions?: number;
  redis?: {
    host: string;
    port: number;
    password?: string;
    tls?: boolean;
  };
  cacheTtlSeconds?: number;
  /** Max concurrent Bedrock requests (default: 10) */
  maxConcurrency?: number;
  /** Max retry attempts for throttling (default: 3) */
  maxRetries?: number;
}

interface EmbeddingRequest {
  content: string;
  id: string;
  resolve: (embedding: number[]) => void;
  reject: (error: Error) => void;
}

/**
 * Simple semaphore for limiting concurrent async operations
 */
class Semaphore {
  private available: number;
  private waiting: Array<() => void> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

export class EmbedderService {
  private client: BedrockRuntimeClient;
  private redis: Redis | null = null;
  private modelId: string;
  private dimensions: number;
  private cacheTtlSeconds: number;

  // Rate limiting
  private semaphore: Semaphore;
  private maxRetries: number;

  // Batching
  private queue: EmbeddingRequest[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly maxBatchSize = 25;
  private readonly maxWaitMs = 100;

  constructor(config: EmbedderConfig = {}) {
    this.client = new BedrockRuntimeClient({
      region: config.region ?? 'us-east-1',
    });

    this.modelId = config.modelId ?? 'amazon.titan-embed-text-v2:0';
    this.dimensions = config.dimensions ?? 1024;
    this.cacheTtlSeconds = config.cacheTtlSeconds ?? 86400 * 30; // 30 days

    // Rate limiting: default 10 concurrent requests to Bedrock
    this.semaphore = new Semaphore(config.maxConcurrency ?? 10);
    this.maxRetries = config.maxRetries ?? 3;

    // Initialize Redis if configured
    if (config.redis) {
      this.redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        tls: config.redis.tls ? {} : undefined,
        lazyConnect: true,
      });
    }
  }

  /**
   * Connect to Redis (if configured)
   */
  async connect(): Promise<void> {
    if (this.redis) {
      await this.redis.connect();
      console.log('[EmbedderService] Connected to Redis');
    }
  }

  /**
   * Embed a single text (uses batching internally)
   */
  async embed(content: string): Promise<number[]> {
    const contentHash = this.hashContent(content);

    // Check cache first
    if (this.redis) {
      const cached = await this.getCached(contentHash);
      if (cached) {
        return cached;
      }
    }

    // Queue for batching
    return new Promise((resolve, reject) => {
      this.queue.push({ content, id: contentHash, resolve, reject });
      this.scheduleFlush();
    });
  }

  /**
   * Embed multiple texts (direct batch)
   */
  async embedBatch(contents: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const toEmbed: Array<{ index: number; content: string; hash: string }> = [];

    // Check cache for each
    for (let i = 0; i < contents.length; i++) {
      const hash = this.hashContent(contents[i]);

      if (this.redis) {
        const cached = await this.getCached(hash);
        if (cached) {
          results[i] = cached;
          continue;
        }
      }

      toEmbed.push({ index: i, content: contents[i], hash });
    }

    // Embed uncached in batches
    for (let i = 0; i < toEmbed.length; i += this.maxBatchSize) {
      const batch = toEmbed.slice(i, i + this.maxBatchSize);
      const embeddings = await this.embedBatchDirect(batch.map((b) => b.content));

      for (let j = 0; j < batch.length; j++) {
        results[batch[j].index] = embeddings[j];

        // Cache the result
        if (this.redis) {
          await this.setCached(batch[j].hash, embeddings[j]);
        }
      }
    }

    return results;
  }

  /**
   * Get embedding for content, using cache
   */
  async getOrEmbed(content: string): Promise<{ embedding: number[]; cached: boolean }> {
    const contentHash = this.hashContent(content);

    // Check cache
    if (this.redis) {
      const cached = await this.getCached(contentHash);
      if (cached) {
        return { embedding: cached, cached: true };
      }
    }

    // Embed
    const embedding = await this.embedSingle(content);

    // Cache
    if (this.redis) {
      await this.setCached(contentHash, embedding);
    }

    return { embedding, cached: false };
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    await this.flush();

    if (this.redis) {
      await this.redis.quit();
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
    } else {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.maxWaitMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatchSize);

    try {
      const embeddings = await this.embedBatchDirect(batch.map((b) => b.content));

      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(embeddings[i]);

        // Cache
        if (this.redis) {
          await this.setCached(batch[i].id, embeddings[i]);
        }
      }
    } catch (error) {
      for (const req of batch) {
        req.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Continue if more in queue
    if (this.queue.length > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * Embed a single text with rate limiting and retry logic
   */
  private async embedSingle(content: string): Promise<number[]> {
    await this.semaphore.acquire();

    try {
      return await this.embedWithRetry(content);
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Embed with exponential backoff retry for transient errors
   */
  private async embedWithRetry(content: string, attempt = 1): Promise<number[]> {
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: content.slice(0, 8192), // Titan limit
            dimensions: this.dimensions,
            normalize: true,
          }),
        })
      );

      const result = JSON.parse(new TextDecoder().decode(response.body));
      return result.embedding;
    } catch (error) {
      // Retry on throttling or temporary service unavailability
      const isRetryable =
        error instanceof ThrottlingException ||
        error instanceof ServiceUnavailableException ||
        (error instanceof Error && error.name === 'ThrottlingException');

      if (isRetryable && attempt < this.maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, etc.
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.warn(
          `[EmbedderService] Throttled, retrying in ${delayMs}ms (attempt ${attempt}/${this.maxRetries})`
        );
        await this.sleep(delayMs);
        return this.embedWithRetry(content, attempt + 1);
      }

      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async embedBatchDirect(contents: string[]): Promise<number[][]> {
    // Titan doesn't support batch embedding, so we parallelize
    const results = await Promise.all(
      contents.map((content) => this.embedSingle(content))
    );
    return results;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private async getCached(hash: string): Promise<number[] | null> {
    if (!this.redis) return null;

    try {
      const cached = await this.redis.get(`emb:${hash}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.warn('[EmbedderService] Cache read error:', error);
    }

    return null;
  }

  private async setCached(hash: string, embedding: number[]): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.set(
        `emb:${hash}`,
        JSON.stringify(embedding),
        'EX',
        this.cacheTtlSeconds
      );
    } catch (error) {
      console.warn('[EmbedderService] Cache write error:', error);
    }
  }
}
