/**
 * Durable, accepted PR-review memory.
 *
 * The control plane writes one immutable/provenance-rich item per accepted review thread after
 * the PR merges. Workers query the repo-scoped `status` partition at the start of a future job.
 * Keeping this in the existing Hermes table makes the learning path event-driven and avoids a
 * second service hop in the latency-sensitive worker startup path.
 */
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { WorkerType } from './jobs.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.JOBS_TABLE!;

const REVIEW_LEARNING_ENABLED = !/^(0|false|no|off)$/i.test(process.env.REVIEW_LEARNING_ENABLED ?? 'true');
const configuredTtlDays = Number(process.env.REVIEW_LEARNING_TTL_DAYS);
const REVIEW_LEARNING_TTL_DAYS = Number.isFinite(configuredTtlDays)
  ? Math.max(30, Math.floor(configuredTtlDays))
  : 365;
export const REVIEW_LEARNING_OPTOUT_LABEL =
  (process.env.REVIEW_LEARNING_OPTOUT_LABEL ?? 'hermes-no-learn').trim().toLowerCase();

export type ReviewLessonEvidence = 'thread_resolved' | 'hermes_replied' | 'reviewer_approved';

/** A review lesson that has enough evidence to become durable only if its PR subsequently merges. */
export interface ReviewLessonCandidate {
  sourceId: string;
  feedbackCommentId?: string;
  path?: string;
  line?: number;
  feedback: string;
  reviewerLogins: string[];
  reviewerAssociations: string[];
  sourceUrl: string;
  feedbackCreatedAt: string;
  evidence: ReviewLessonEvidence;
  resolvedBy?: string;
  fixCommitSha?: string;
}

export interface RecordMergedReviewLessonsInput {
  repo: string;
  type: WorkerType;
  baseBranch: string;
  prNumber: number;
  prUrl: string;
  mergeCommitSha: string;
  issueKey?: string;
  labels?: string[];
  lessons: ReviewLessonCandidate[];
}

function lessonKey(repo: string, sourceId: string): string {
  const digest = createHash('sha256').update(`${repo}\0${sourceId}`).digest('hex').slice(0, 40);
  return `review-memory:${digest}`;
}

function feedbackHash(feedback: string): string {
  return createHash('sha256').update(feedback).digest('hex');
}

/**
 * Persist accepted review lessons. BatchPut is intentionally idempotent: a duplicate merge webhook
 * overwrites the same source-derived keys, while a later reconciliation can refresh corrected
 * provenance. Failure is allowed to bubble so the caller can log it without blocking merge flow.
 */
export async function recordMergedReviewLessons(input: RecordMergedReviewLessonsInput): Promise<number> {
  if (!REVIEW_LEARNING_ENABLED || !TABLE || !input.lessons.length) return 0;
  if (
    REVIEW_LEARNING_OPTOUT_LABEL &&
    (input.labels ?? []).some((label) => label.trim().toLowerCase() === REVIEW_LEARNING_OPTOUT_LABEL)
  ) {
    return 0;
  }

  const learnedAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + REVIEW_LEARNING_TTL_DAYS * 24 * 60 * 60;
  const items = input.lessons.map((lesson) => ({
    jobId: lessonKey(input.repo, lesson.sourceId),
    status: `review-memory:${input.repo}`,
    kind: 'review_learning',
    repo: input.repo,
    type: input.type,
    baseBranch: input.baseBranch,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    mergeCommitSha: input.mergeCommitSha,
    issueKey: input.issueKey,
    sourceId: lesson.sourceId,
    feedbackCommentId: lesson.feedbackCommentId,
    path: lesson.path,
    line: lesson.line,
    feedback: lesson.feedback,
    feedbackHash: feedbackHash(lesson.feedback),
    reviewerLogins: lesson.reviewerLogins,
    reviewerAssociations: lesson.reviewerAssociations,
    sourceUrl: lesson.sourceUrl,
    evidence: lesson.evidence,
    resolvedBy: lesson.resolvedBy,
    fixCommitSha: lesson.fixCommitSha,
    feedbackCreatedAt: lesson.feedbackCreatedAt,
    learnedAt,
    createdAt: learnedAt,
    updatedAt: learnedAt,
    expiresAt,
  }));

  for (let offset = 0; offset < items.length; offset += 25) {
    type WriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];
    let pending: WriteRequest[] = items
      .slice(offset, offset + 25)
      .map((Item): WriteRequest => ({ PutRequest: { Item } }));
    for (let attempt = 1; pending.length && attempt <= 3; attempt++) {
      const result = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [TABLE]: pending },
        })
      );
      pending = result.UnprocessedItems?.[TABLE] ?? [];
      if (pending.length && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    if (pending.length) {
      throw new Error(`DynamoDB left ${pending.length} review-memory write(s) unprocessed`);
    }
  }
  return items.length;
}
