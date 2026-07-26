/**
 * Regression tests for the signal-dedupe starvation bug.
 *
 * Live failure this locks out: PR donate-mate/donatemate#772 sat red and untouched for 24h at
 * fixAttemptCount=1 (cap 8). Its head never moved off d726d96c because the fix job produced no
 * commit, so the still-failing "Enforce OpenAPI Sync" check kept emitting the identical signal id —
 * which startFollowupJob had already written to handledSignalIds at *enqueue* time. The signal was
 * therefore deduped forever and no further fix was ever attempted.
 */
process.env.JOBS_TABLE ??= 'test-table';
process.env.AWS_REGION ??= 'us-east-2';

import { describe, expect, it } from 'vitest';
import {
  dedupeNewSignals,
  isRetryOfHandledSignal,
  reviewReplyTargetsForSignals,
  shouldFinalizeReviewLearningCapture,
} from './prMonitor.js';
import { isRateLimitError } from './github.js';
import type { PrSignal, PrWatch } from './prWatch.js';

const HEAD = 'd726d96c4c1cf8055825279bd75c622aca98e504';
const CI_ID = `ci:${HEAD}:check:86290059761:failure`;
const REVIEW_ID = 'review:PRRT_kwDOPtny286PqH_Y:PRRC_kwDOPtny287T0TZK';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function watch(over: Partial<PrWatch> = {}): PrWatch {
  return {
    jobId: 'prwatch:donate-mate/donatemate#772',
    status: 'prwatch:watching',
    repo: 'donate-mate/donatemate',
    prNumber: 772,
    prUrl: 'https://github.com/donate-mate/donatemate/pull/772',
    sourceJobId: 'src',
    type: 'be',
    baseBranch: 'develop',
    headBranch: 'hermes/dm-579',
    headSha: HEAD,
    originalPrompt: 'DM-579',
    jiraState: 'fixing_ci',
    fixAttemptCount: 1,
    handledSignalIds: [CI_ID, REVIEW_ID],
    lastFixAt: minutesAgo(60),
    createdAt: minutesAgo(4000),
    updatedAt: minutesAgo(60),
    expiresAt: 0,
    ...over,
  };
}

const ciSignal = (id = CI_ID): PrSignal => ({
  id,
  kind: 'ci_failed',
  summary: 'Enforce OpenAPI Sync failed',
  createdAt: minutesAgo(30),
});
const reviewSignal = (id = REVIEW_ID): PrSignal => ({
  id,
  kind: 'review_feedback',
  summary: 'unresolved review thread',
  createdAt: minutesAgo(30),
});
const conflictSignal = (): PrSignal => ({
  id: `merge:${HEAD}`,
  kind: 'merge_conflict',
  summary: 'branch has conflicts with develop',
  createdAt: minutesAgo(30),
});

describe('dedupeNewSignals', () => {
  it('re-fires a still-failing CI signal a previous attempt did not resolve (the #772 freeze)', () => {
    const out = dedupeNewSignals(watch(), [ciSignal()]);
    expect(out.map((s) => s.id)).toEqual([CI_ID]);
  });

  it('re-fires a still-present merge conflict', () => {
    const out = dedupeNewSignals(watch({ handledSignalIds: [`merge:${HEAD}`] }), [conflictSignal()]);
    expect(out).toHaveLength(1);
  });

  it('does NOT re-fire handled review feedback — it never self-clears, so it would loop forever', () => {
    const out = dedupeNewSignals(watch(), [reviewSignal()]);
    expect(out).toEqual([]);
  });

  it('holds a retry inside the cooldown so a fast-failing check cannot spin the fixer', () => {
    const out = dedupeNewSignals(watch({ lastFixAt: minutesAgo(2) }), [ciSignal()]);
    expect(out).toEqual([]);
  });

  it('still fires a genuinely new CI signal while cooling down', () => {
    const fresh = ciSignal('ci:aa8a0873:check:999:failure');
    const out = dedupeNewSignals(watch({ lastFixAt: minutesAgo(2) }), [fresh]);
    expect(out.map((s) => s.id)).toEqual([fresh.id]);
  });

  it('collapses duplicate ids within one batch', () => {
    const out = dedupeNewSignals(watch({ handledSignalIds: [] }), [ciSignal(), ciSignal()]);
    expect(out).toHaveLength(1);
  });

  it('fires unhandled signals of every kind', () => {
    const out = dedupeNewSignals(watch({ handledSignalIds: [] }), [ciSignal(), reviewSignal(), conflictSignal()]);
    expect(out).toHaveLength(3);
  });

  it('treats a watch with no lastFixAt as past the cooldown', () => {
    const out = dedupeNewSignals(watch({ lastFixAt: undefined }), [ciSignal()]);
    expect(out).toHaveLength(1);
  });
});

describe('isRetryOfHandledSignal', () => {
  it('flags a re-attempt so the follow-up prompt can escalate', () => {
    expect(isRetryOfHandledSignal(watch(), [ciSignal()])).toBe(true);
  });

  it('does not flag a first attempt', () => {
    expect(isRetryOfHandledSignal(watch({ handledSignalIds: [] }), [ciSignal()])).toBe(false);
  });
});

describe('reviewReplyTargetsForSignals', () => {
  it('keeps only fully-addressable inline review signals', () => {
    const inline: PrSignal = {
      ...reviewSignal(),
      reviewThreadId: 'PRRT_thread',
      reviewCommentId: 'PRRC_feedback',
      reviewRootCommentId: 3_553_703_498,
      url: 'https://github.com/example/repo/pull/1#discussion_r3553703498',
    };

    expect(reviewReplyTargetsForSignals([inline, reviewSignal('review-state:123')])).toEqual([
      {
        threadId: 'PRRT_thread',
        feedbackCommentId: 'PRRC_feedback',
        rootCommentId: 3_553_703_498,
        url: inline.url,
      },
    ]);
  });
});

describe('review-learning capture completion', () => {
  it('defers an empty merge snapshot until the durable pending request is retried', () => {
    expect(shouldFinalizeReviewLearningCapture(0)).toBe(false);
  });

  it('finalizes an accepted lesson immediately and a zero-lesson backfill exactly once', () => {
    expect(shouldFinalizeReviewLearningCapture(1)).toBe(true);
    expect(shouldFinalizeReviewLearningCapture(0, true)).toBe(true);
  });
});

describe('GitHub rate-limit classification', () => {
  it('recognizes REST and status-less GraphQL quota errors', () => {
    expect(isRateLimitError({ status: 403, message: 'API rate limit exceeded' })).toBe(true);
    expect(isRateLimitError({ status: 429, message: 'Too Many Requests' })).toBe(true);
    expect(
      isRateLimitError({
        status: 403,
        message: 'Forbidden',
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      })
    ).toBe(true);
    expect(isRateLimitError(new Error('GitHub GraphQL: API rate limit exceeded'))).toBe(true);
    expect(
      isRateLimitError(
        Object.assign(new Error('GitHub GraphQL: request failed'), { code: 'RATE_LIMITED' })
      )
    ).toBe(true);
  });

  it('does not treat permission failures or unrelated GraphQL errors as rate limits', () => {
    expect(
      isRateLimitError({ status: 403, message: 'Resource not accessible by integration' })
    ).toBe(false);
    expect(isRateLimitError(new Error('GitHub GraphQL: repository not found'))).toBe(false);
  });
});
