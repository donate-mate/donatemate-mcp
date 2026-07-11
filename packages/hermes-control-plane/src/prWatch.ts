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
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

const ttl = () => Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
export const prWatchKey = (repo: string, prNumber: number): string => `prwatch:${repo}#${prNumber}`;

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
