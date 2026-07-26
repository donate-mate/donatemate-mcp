/**
 * PR watch state lives in the Hermes jobs table under synthetic keys:
 *   prwatch:<owner>/<repo>#<number>
 * The monitor uses conditional updates so multiple control-plane tasks can receive the same
 * webhook/reconcile tick without queuing duplicate follow-up jobs.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { WorkerType } from './jobs.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.JOBS_TABLE!;

export type PrWatchStatus = 'watching' | 'fixing' | 'qa_queued' | 'qa_running' | 'blocked' | 'done';
export type JiraState =
  | 'planned'
  | 'implementing'
  | 'pr_open'
  | 'fixing_ci'
  | 'fixing_review'
  | 'fixing_merge_conflict'
  | 'waiting_ci'
  | 'ready_review'
  | 'qa_waiting_build'
  | 'ready_qa'
  | 'qa_running'
  | 'qa_failed'
  | 'qa_passed'
  | 'blocked'
  | 'done';
export type PrSignalKind = 'ci_failed' | 'review_feedback' | 'merge_conflict';

export interface PrSignal {
  id: string;
  kind: PrSignalKind;
  summary: string;
  details?: string;
  url?: string;
  headSha?: string;
  /** GraphQL node id for an inline review thread. Present only for thread feedback. */
  reviewThreadId?: string;
  /** GraphQL node id for the reviewer comment that made this feedback actionable. */
  reviewCommentId?: string;
  /** REST database id of the thread's top-level comment, required by GitHub's reply endpoint. */
  reviewRootCommentId?: number;
  createdAt: string;
}

export interface PrWatch {
  jobId: string;
  status: `prwatch:${PrWatchStatus}`;
  repo: string;
  prNumber: number;
  prUrl: string;
  sourceJobId: string;
  type: WorkerType;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  originalPrompt: string;
  issueKey?: string;
  channel?: string;
  threadTs?: string;
  jiraState: JiraState;
  fixAttemptCount: number;
  activeFixJobId?: string;
  activeQaJobId?: string;
  blockReason?: string;
  deployRunUrl?: string;
  handledSignalIds?: string[];
  /** When the most recent fix job was started — throttles retries of a still-unresolved signal. */
  lastFixAt?: string;
  /** The most recent fix job, kept after it clears so a retry can read why the last attempt failed. */
  lastFixJobId?: string;
  /** Head sha we last re-requested human review at, so a green PR is only re-pinged once per head. */
  lastReviewPingSha?: string;
  /** Present while follow-up work is intentionally paused because Jira is not assigned to Hermes. */
  assignmentPausedAt?: string;
  /** Durable receipt that accepted review feedback was evaluated after merge. */
  reviewLearningCapturedAt?: string;
  /** Number of accepted lessons persisted by the merge/backfill capture. Zero is a valid result. */
  reviewLearningLessonCount?: number;
  /** Merge commit whose accepted review history was evaluated. */
  reviewLearningMergeCommitSha?: string;
  /** Extraction/trust schema used for the durable receipt. */
  reviewLearningCaptureVersion?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

interface ReviewLearningCaptureRequest {
  jobId: string;
  status:
    | 'reviewcapture:pending'
    | 'reviewcapture:done'
    | 'reviewcapture:orphaned'
    | 'reviewcapture:failed'
    | 'reviewcapture:superseded';
  watchJobId: string;
  repo: string;
  prNumber: number;
  mergeCommitSha: string;
  captureVersion?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

interface ReviewLearningMigrationState {
  jobId: string;
  status: 'reviewcapture:migration-running' | 'reviewcapture:migration-done';
  cursor?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const ttl = () => Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
export const prWatchKey = (repo: string, prNumber: number): string => `prwatch:${repo}#${prNumber}`;
export const REVIEW_LEARNING_CAPTURE_VERSION = 2;
export const reviewLearningCaptureKey = (
  repo: string,
  prNumber: number,
  captureVersion = REVIEW_LEARNING_CAPTURE_VERSION
): string => `reviewcapture:v${captureVersion}:${repo}#${prNumber}`;
const REVIEW_LEARNING_MIGRATION_KEY =
  `reviewcapture:migration-v${REVIEW_LEARNING_CAPTURE_VERSION}`;

export function hasCurrentReviewLearningCapture(
  watch: Pick<PrWatch, 'reviewLearningCapturedAt' | 'reviewLearningCaptureVersion'>
): boolean {
  return Boolean(
    watch.reviewLearningCapturedAt &&
      Number(watch.reviewLearningCaptureVersion ?? 0) >= REVIEW_LEARNING_CAPTURE_VERSION
  );
}

export async function getPrWatch(repo: string, prNumber: number): Promise<PrWatch | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId: prWatchKey(repo, prNumber) } }));
  return res.Item as PrWatch | undefined;
}

export async function listActivePrWatches(): Promise<PrWatch[]> {
  const statuses: Array<PrWatch['status']> = ['prwatch:watching', 'prwatch:fixing'];
  const batches = await Promise.all(
    statuses.map((status) =>
      ddb.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: 'status-index',
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
          Limit: 100,
        })
      )
    )
  );
  return batches.flatMap((b) => (b.Items ?? []) as PrWatch[]);
}

export async function listBlockedPrWatches(): Promise<PrWatch[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'prwatch:blocked' },
      Limit: 100,
    })
  );
  return (res.Items ?? []) as PrWatch[];
}

/**
 * One-time migration for watches completed before durable capture requests existed.
 *
 * Each sweep evaluates one bounded status-index page and persists its LastEvaluatedKey. Eligibility
 * uses updatedAt (the legacy terminal transition timestamp), not the PR/watch creation timestamp.
 * The cursor only advances after every eligible row on the page has a deterministic pending
 * request, so a transient write failure retries the same page instead of silently skipping it.
 */
export async function seedLegacyReviewLearningCaptureRequests(maxEvaluated = 100): Promise<PrWatch[]> {
  const stateResult = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { jobId: REVIEW_LEARNING_MIGRATION_KEY } })
  );
  const state = stateResult.Item as ReviewLearningMigrationState | undefined;
  if (state?.completedAt) return [];

  const configuredDays = Number(process.env.REVIEW_LEARNING_LEGACY_MIGRATION_DAYS ?? 30);
  const days = Number.isFinite(configuredDays) ? Math.max(1, Math.floor(configuredDays)) : 30;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = Number.isFinite(maxEvaluated) ? Math.max(1, Math.floor(maxEvaluated)) : 100;
  const page = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'prwatch:done' },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: state?.cursor,
    })
  );
  const eligible = ((page.Items ?? []) as PrWatch[]).filter(
    (watch) =>
      !hasCurrentReviewLearningCapture(watch) &&
      Number.isFinite(Date.parse(watch.updatedAt)) &&
      Date.parse(watch.updatedAt) >= cutoffMs
  );
  await Promise.all(
    eligible.map((watch) =>
      ensureReviewLearningCapturePending(
        watch,
        watch.reviewLearningMergeCommitSha || watch.headSha
      )
    )
  );

  const now = new Date().toISOString();
  const cursor = page.LastEvaluatedKey as Record<string, string> | undefined;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: REVIEW_LEARNING_MIGRATION_KEY },
      UpdateExpression: cursor
        ? 'SET #s = :running, #cursor = :cursor, createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt'
        : 'SET #s = :done, completedAt = :completedAt, createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt REMOVE #cursor',
      ExpressionAttributeNames: { '#s': 'status', '#cursor': 'cursor' },
      ExpressionAttributeValues: {
        ...(cursor
          ? { ':running': 'reviewcapture:migration-running', ':cursor': cursor }
          : { ':done': 'reviewcapture:migration-done', ':completedAt': now }),
        ':createdAt': now,
        ':updatedAt': now,
      },
    })
  );
  // Seed the whole durable page, but keep the current reconcile tick bounded to the same batch size
  // as normal backfill. The remaining requests are selected directly from the pending partition on
  // later ticks instead of turning a schema upgrade into an unbounded control-plane sweep.
  return eligible.slice(0, Math.min(25, limit));
}

/**
 * Durable merge-time capture requests that have passed the GitHub settle delay.
 *
 * Requests have their own status-index partition, timestamped when merge completion is observed.
 * The query therefore selects pending work directly: long-lived PRs are not excluded by their
 * original watch timestamp, and newer completed watches cannot starve older requests behind a
 * filtered/page-capped query.
 */
export async function listReviewLearningBackfillWatches(maxResults = 25): Promise<PrWatch[]> {
  const configuredDelay = Number(process.env.REVIEW_LEARNING_BACKFILL_DELAY_SECONDS ?? 60);
  const delaySeconds = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 60;
  const readyBefore = new Date(Date.now() - delaySeconds * 1000).toISOString();
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :s AND createdAt <= :readyBefore',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'reviewcapture:pending',
        ':readyBefore': readyBefore,
      },
      ScanIndexForward: true,
      Limit: Math.max(1, Math.floor(maxResults)),
    })
  );
  const requests = (res.Items ?? []) as ReviewLearningCaptureRequest[];
  const watches = await Promise.all(
    requests.map(async (request) => {
      const watch = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { jobId: request.watchJobId } })
      );
      return watch.Item as PrWatch | undefined;
    })
  );
  await Promise.all(
    requests.map(async (request, index) => {
      const watch = watches[index];
      if (watch) {
        const currentKey = reviewLearningCaptureKey(watch.repo, watch.prNumber);
        if (request.jobId === currentKey) return;

        // A rolling schema upgrade can select a legacy pending row. Create the current request
        // before retiring the old one so a crash cannot lose the capture, then let this same sweep
        // process the watch against the current-version key.
        await ensureReviewLearningCapturePending(
          watch,
          request.mergeCommitSha || watch.reviewLearningMergeCommitSha || watch.headSha
        );
        const now = new Date().toISOString();
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { jobId: request.jobId },
              UpdateExpression:
                'SET #s = :superseded, supersededBy = :supersededBy, supersededAt = :supersededAt, updatedAt = :updatedAt, expiresAt = :expiresAt',
              ConditionExpression: '#s = :pending',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: {
                ':pending': 'reviewcapture:pending',
                ':superseded': 'reviewcapture:superseded',
                ':supersededBy': currentKey,
                ':supersededAt': now,
                ':updatedAt': now,
                ':expiresAt': ttl(),
              },
            })
          );
        } catch (err) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        }
        return;
      }
      const now = new Date().toISOString();
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { jobId: request.jobId },
            UpdateExpression:
              'SET #s = :orphaned, orphanedAt = :orphanedAt, updatedAt = :updatedAt, expiresAt = :expiresAt',
            ConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':pending': 'reviewcapture:pending',
              ':orphaned': 'reviewcapture:orphaned',
              ':orphanedAt': now,
              ':updatedAt': now,
              ':expiresAt': ttl(),
            },
          })
        );
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    })
  );
  return watches.filter((watch): watch is PrWatch => Boolean(watch));
}

/**
 * Create a durable retry request before the merge snapshot is evaluated.
 *
 * The deterministic key plus conditional put makes this an outbox receipt: duplicate webhook
 * replicas cannot create duplicate work, and a completed request cannot be recreated by a stale
 * replica. Its createdAt is the merge-observed timestamp used by the delayed status-index query.
 */
export async function ensureReviewLearningCapturePending(
  watch: PrWatch,
  mergeCommitSha: string
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          jobId: reviewLearningCaptureKey(watch.repo, watch.prNumber),
          status: 'reviewcapture:pending',
          watchJobId: watch.jobId,
          repo: watch.repo,
          prNumber: watch.prNumber,
          mergeCommitSha,
          captureVersion: REVIEW_LEARNING_CAPTURE_VERSION,
          createdAt: now,
          updatedAt: now,
          expiresAt: ttl(),
        } satisfies ReviewLearningCaptureRequest,
        ConditionExpression: 'attribute_not_exists(jobId)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Retire the durable capture request after the watch has its terminal capture receipt. */
export async function markReviewLearningCaptureCompleted(
  watch: PrWatch,
  lessonCount: number,
  mergeCommitSha: string
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: reviewLearningCaptureKey(watch.repo, watch.prNumber) },
        UpdateExpression:
          'SET #s = :done, lessonCount = :lessonCount, mergeCommitSha = :mergeCommitSha, captureVersion = :captureVersion, capturedAt = :capturedAt, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'reviewcapture:pending',
          ':done': 'reviewcapture:done',
          ':lessonCount': Math.max(0, Math.floor(lessonCount)),
          ':mergeCommitSha': mergeCommitSha,
          ':captureVersion': REVIEW_LEARNING_CAPTURE_VERSION,
          ':capturedAt': now,
          ':updatedAt': now,
          ':expiresAt': ttl(),
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Count an isolated backfill failure and dead-letter a poison request after a bounded number of
 * sweeps. Shared GitHub rate-limit failures are handled by the caller and never charged here.
 */
export async function recordReviewLearningCaptureFailure(
  watch: PrWatch,
  error: unknown
): Promise<{ attempts: number; terminal: boolean }> {
  const configuredMax = Number(process.env.REVIEW_LEARNING_BACKFILL_MAX_ATTEMPTS ?? 5);
  const maxAttempts = Number.isFinite(configuredMax) ? Math.max(1, Math.floor(configuredMax)) : 5;
  const now = new Date().toISOString();
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
    0,
    1000
  );
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: reviewLearningCaptureKey(watch.repo, watch.prNumber) },
        UpdateExpression:
          'SET lastError = :lastError, lastFailedAt = :lastFailedAt, updatedAt = :updatedAt, expiresAt = :expiresAt ADD failureCount :one',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'reviewcapture:pending',
          ':lastError': message,
          ':lastFailedAt': now,
          ':updatedAt': now,
          ':expiresAt': ttl(),
          ':one': 1,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const attempts = Number(result.Attributes?.failureCount ?? 0);
    if (attempts < maxAttempts) return { attempts, terminal: false };

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: reviewLearningCaptureKey(watch.repo, watch.prNumber) },
        UpdateExpression:
          'SET #s = :failed, failedAt = :failedAt, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: '#s = :pending AND failureCount >= :maxAttempts',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'reviewcapture:pending',
          ':failed': 'reviewcapture:failed',
          ':failedAt': now,
          ':updatedAt': now,
          ':expiresAt': ttl(),
          ':maxAttempts': maxAttempts,
        },
      })
    );
    return { attempts, terminal: true };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { attempts: 0, terminal: false };
    }
    throw err;
  }
}

/** Mark review-learning capture exactly once so concurrent webhook replicas remain idempotent. */
export async function markReviewLearningCaptured(
  watch: PrWatch,
  lessonCount: number,
  mergeCommitSha: string
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression:
          'SET reviewLearningCapturedAt = :capturedAt, reviewLearningLessonCount = :lessonCount, reviewLearningMergeCommitSha = :mergeCommitSha, reviewLearningCaptureVersion = :captureVersion, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression:
          'attribute_exists(jobId) AND (attribute_not_exists(reviewLearningCapturedAt) OR attribute_not_exists(reviewLearningCaptureVersion) OR reviewLearningCaptureVersion < :captureVersion)',
        ExpressionAttributeValues: {
          ':capturedAt': now,
          ':lessonCount': Math.max(0, Math.floor(lessonCount)),
          ':mergeCommitSha': mergeCommitSha,
          ':captureVersion': REVIEW_LEARNING_CAPTURE_VERSION,
          ':updatedAt': now,
          ':expiresAt': ttl(),
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Claim the right to run the periodic reconcile sweep. Every control-plane replica runs the same
 * timer, so without this the whole fleet sweeps on every tick — duplicate GitHub reads that buy
 * nothing (the replicas already race harmlessly on conditional writes) and that helped exhaust the
 * hourly REST budget. Whoever wins the conditional update sweeps; the rest skip this tick.
 * Fail-open: on any unexpected error we sweep, because a missed sweep is worse than a duplicate one.
 */
export async function acquireReconcileLease(minIntervalSeconds: number): Promise<boolean> {
  const now = Date.now();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: 'reconcile-lease' },
        UpdateExpression: 'SET leaseAt = :now, #s = :s, expiresAt = :ttl',
        ConditionExpression: 'attribute_not_exists(leaseAt) OR leaseAt < :cutoff',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':now': now,
          ':cutoff': now - minIntervalSeconds * 1000,
          ':s': 'lease',
          ':ttl': Math.floor(now / 1000) + 24 * 3600,
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    return true;
  }
}

export async function markWatchQaQueued(watch: PrWatch, qaJobId: string, headSha: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression:
          'SET #s = :qaQueued, jiraState = :jiraState, activeQaJobId = :qaJobId, headSha = :headSha, updatedAt = :updatedAt, expiresAt = :expiresAt REMOVE blockReason, deployRunUrl',
        ConditionExpression: '#s <> :done AND (attribute_not_exists(activeQaJobId) OR activeQaJobId = :emptyActive)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':qaQueued': 'prwatch:qa_queued',
          ':done': 'prwatch:done',
          ':jiraState': 'qa_waiting_build',
          ':qaJobId': qaJobId,
          ':emptyActive': '',
          ':headSha': headSha,
          ':updatedAt': new Date().toISOString(),
          ':expiresAt': ttl(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function rememberGitHubDelivery(deliveryId: string): Promise<boolean> {
  if (!deliveryId) return true;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          jobId: `ghevent:${deliveryId}`,
          status: 'ghevent',
          createdAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        },
        ConditionExpression: 'attribute_not_exists(jobId)',
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function updateWatchHead(watch: PrWatch, headSha: string, headBranch: string, prUrl: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: watch.jobId },
      UpdateExpression: 'SET headSha = :headSha, headBranch = :headBranch, prUrl = :prUrl, updatedAt = :updatedAt, expiresAt = :expiresAt',
      ExpressionAttributeValues: {
        ':headSha': headSha,
        ':headBranch': headBranch,
        ':prUrl': prUrl,
        ':updatedAt': new Date().toISOString(),
        ':expiresAt': ttl(),
      },
    })
  );
}

export async function tryStartFix(
  watch: PrWatch,
  fixJobId: string,
  jiraState: JiraState,
  nextAttempt: number
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression:
          'SET #s = :fixing, jiraState = :jiraState, activeFixJobId = :fixJobId, lastFixJobId = :fixJobId, lastFixAt = :updatedAt, fixAttemptCount = :nextAttempt, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: '#s = :watching AND (attribute_not_exists(activeFixJobId) OR activeFixJobId = :emptyActive)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':fixing': 'prwatch:fixing',
          ':watching': 'prwatch:watching',
          ':jiraState': jiraState,
          ':fixJobId': fixJobId,
          ':nextAttempt': nextAttempt,
          ':emptyActive': '',
          ':updatedAt': new Date().toISOString(),
          ':expiresAt': ttl(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function appendHandledSignals(watch: PrWatch, signalIds: string[]): Promise<void> {
  // Only append ids we have not already recorded. Without this the list grows without bound (the
  // same `overlap:<peer>` / `checklist-posted` markers get re-appended on every reconcile whenever a
  // caller works from a slightly stale watch), and a long-lived watch eventually hits the 400KB
  // DynamoDB item limit.
  const known = new Set(watch.handledSignalIds ?? []);
  const fresh = [...new Set(signalIds)].filter((id) => !known.has(id));
  if (!fresh.length) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: watch.jobId },
      UpdateExpression:
        'SET handledSignalIds = list_append(if_not_exists(handledSignalIds, :empty), :signalIds), updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':empty': [],
        ':signalIds': fresh,
        ':updatedAt': new Date().toISOString(),
      },
    })
  );
}

/** Record an assignment pause exactly once so Jira comments and flow updates are idempotent. */
export async function markWatchAssignmentPaused(watch: PrWatch): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET assignmentPausedAt = :pausedAt, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_not_exists(assignmentPausedAt)',
        ExpressionAttributeValues: {
          ':pausedAt': new Date().toISOString(),
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

/** Clear the pause and remove the legacy handled-signal marker without replacing the whole list. */
export async function clearWatchAssignmentPause(watch: PrWatch): Promise<boolean> {
  const legacyIndex = (watch.handledSignalIds ?? []).indexOf('unassigned-paused');
  const removes = ['assignmentPausedAt'];
  if (legacyIndex >= 0) removes.push(`handledSignalIds[${legacyIndex}]`);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: `SET updatedAt = :updatedAt REMOVE ${removes.join(', ')}`,
        ConditionExpression:
          legacyIndex >= 0
            ? `attribute_exists(assignmentPausedAt) OR handledSignalIds[${legacyIndex}] = :legacyMarker`
            : 'attribute_exists(assignmentPausedAt)',
        ExpressionAttributeValues: {
          ':updatedAt': new Date().toISOString(),
          ...(legacyIndex >= 0 ? { ':legacyMarker': 'unassigned-paused' } : {}),
        },
      })
    );
    return true;
  } catch {
    // Another reconciler may have already resumed it.
    return false;
  }
}

/**
 * Record that we re-requested human review at `headSha`, so a green PR whose reviewer left
 * CHANGES_REQUESTED is re-pinged exactly once per head instead of on every reconcile.
 * Returns false if this head was already pinged.
 */
export async function markReviewPinged(watch: PrWatch, headSha: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET lastReviewPingSha = :headSha, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_not_exists(lastReviewPingSha) OR lastReviewPingSha <> :headSha',
        ExpressionAttributeValues: { ':headSha': headSha, ':updatedAt': new Date().toISOString() },
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function markWatchReady(watch: PrWatch, headSha: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET jiraState = :ready, headSha = :headSha, updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: 'jiraState <> :ready AND (#s = :watching OR #s = :fixing)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':ready': 'ready_review',
          ':watching': 'prwatch:watching',
          ':fixing': 'prwatch:fixing',
          ':headSha': headSha,
          ':updatedAt': new Date().toISOString(),
          ':expiresAt': ttl(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearActiveFix(watch: PrWatch, fixJobId: string): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET #s = :watching, activeFixJobId = :emptyActive, updatedAt = :updatedAt',
        ConditionExpression: 'activeFixJobId = :fixJobId',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':watching': 'prwatch:watching',
          ':emptyActive': '',
          ':fixJobId': fixJobId,
          ':updatedAt': new Date().toISOString(),
        },
      })
    )
    .catch(() => {
      /* another reconciler may have moved the watch on */
    });
}

export async function markWatchBlocked(watch: PrWatch, reason: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET #s = :blocked, jiraState = :jiraState, blockReason = :reason, updatedAt = :updatedAt',
        ConditionExpression: '#s <> :done',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':blocked': 'prwatch:blocked',
          ':done': 'prwatch:done',
          ':jiraState': 'blocked',
          ':reason': reason,
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset a blocked watch back to active — clears the block reason, active fix, handled-signal dedupe,
 * and the fix-attempt budget — so the reconcile loop resumes automated fixes. Used when a human
 * advances a blocked PR (auto-unblock) or on an explicit revive. Returns the updated watch, or null.
 */
export async function unblockWatch(watch: PrWatch, headSha: string): Promise<PrWatch | null> {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression:
          'SET #s = :watching, fixAttemptCount = :zero, headSha = :headSha, updatedAt = :updatedAt REMOVE blockReason, activeFixJobId, handledSignalIds',
        ConditionExpression: '#s <> :done',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':watching': 'prwatch:watching',
          ':zero': 0,
          ':headSha': headSha,
          ':updatedAt': new Date().toISOString(),
          ':done': 'prwatch:done',
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return (res.Attributes as PrWatch) ?? null;
  } catch {
    return null;
  }
}

export async function markWatchDone(watch: PrWatch, jiraState: Extract<JiraState, 'done'> = 'done'): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: watch.jobId },
        UpdateExpression: 'SET #s = :done, jiraState = :jiraState, updatedAt = :updatedAt',
        ConditionExpression: '#s <> :done',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':done': 'prwatch:done',
          ':jiraState': jiraState,
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}
