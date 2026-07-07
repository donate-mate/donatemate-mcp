/**
 * Hermes PR Review Ingest Handler
 *
 * Nightly scheduled Lambda that ingests every human code-review comment on
 * Hermes-authored PRs (head branch prefix `hermes/`) in the target GitHub
 * repository into the knowledge base, so future Hermes jobs can surface
 * "previously flagged patterns".
 *
 * Mirrors the wiring of the knowledge-sync / knowledge-indexer handlers:
 * same DATABASE_SECRET_ARN / GITHUB_SECRET_ARN / REDIS_* environment.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  DatabaseService,
  EmbedderService,
  ingestHermesPrReviewComments,
} from '@donatemate/knowledge-base';
import type { ScheduledEvent } from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});

// Target repository for Hermes review ingestion.
const DEFAULT_REPO = 'donate-mate/donatemate';

// Direct-invocation override (for manual/on-demand runs).
interface DirectIngestEvent {
  repo?: string;
  sinceDays?: number;
}

async function getSecret(secretArn: string): Promise<Record<string, string>> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  return JSON.parse(response.SecretString || '{}');
}

export async function handler(
  event: ScheduledEvent | DirectIngestEvent
): Promise<{ ingested: number }> {
  const directEvent = event as DirectIngestEvent;
  const repo = directEvent.repo || DEFAULT_REPO;
  const sinceDays = directEvent.sinceDays;

  const dbSecretArn = process.env.DATABASE_SECRET_ARN;
  if (!dbSecretArn) {
    throw new Error('DATABASE_SECRET_ARN not configured');
  }

  const githubSecretArn = process.env.GITHUB_SECRET_ARN;
  if (!githubSecretArn) {
    throw new Error('GITHUB_SECRET_ARN not configured');
  }

  const dbSecret = await getSecret(dbSecretArn);
  const githubSecret = await getSecret(githubSecretArn);

  const token = githubSecret.token;
  if (!token) {
    console.warn('[hermes-review-ingest] GitHub token not found in secret; aborting');
    return { ingested: 0 };
  }

  const db = new DatabaseService({
    host: dbSecret.host,
    port: parseInt(dbSecret.port || '5432', 10),
    database: dbSecret.dbname || 'knowledge',
    user: dbSecret.username,
    password: dbSecret.password,
    ssl: true,
    maxConnections: 5,
  });

  const redisHost = process.env.REDIS_HOST;
  const embedder = new EmbedderService({
    region: process.env.AWS_REGION,
    ...(redisHost
      ? {
          redis: {
            host: redisHost,
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
          },
        }
      : {}),
  });

  // Redis is best-effort; connection failures must not abort ingestion.
  if (redisHost) {
    try {
      await embedder.connect();
    } catch (err) {
      console.warn('[hermes-review-ingest] Redis connect failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    console.info('[hermes-review-ingest] Starting ingestion', { repo, sinceDays });

    const result = await ingestHermesPrReviewComments({
      db,
      embedder,
      repo,
      token,
      ...(sinceDays != null ? { sinceDays } : {}),
    });

    console.info('[hermes-review-ingest] Ingestion complete', {
      repo,
      ingested: result.ingested,
    });

    return result;
  } catch (err) {
    // Fail open: log and report zero rather than throwing (nightly best-effort).
    console.error('[hermes-review-ingest] Ingestion failed', {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ingested: 0 };
  } finally {
    await Promise.allSettled([db.close(), embedder.close()]);
  }
}
