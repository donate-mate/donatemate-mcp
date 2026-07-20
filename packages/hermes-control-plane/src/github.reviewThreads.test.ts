process.env.AWS_REGION ??= 'us-east-2';

import { describe, expect, it } from 'vitest';
import {
  HERMES_REVIEW_REPLY_MARKER_PREFIX,
  signalFromReviewThreadNode,
} from './github.js';

const root = {
  id: 'PRRC_root',
  databaseId: 3_553_703_498,
  body: 'Please validate the provider schema too.',
  url: 'https://github.com/donate-mate/donatemate/pull/772#discussion_r3553703498',
  createdAt: '2026-07-09T17:50:00Z',
  author: { login: 'reviewer' },
};

function thread(comments: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'PRRT_thread',
    isResolved: false,
    isOutdated: false,
    path: 'packages/models/ocr-models/src/extracted-fields.ts',
    line: 42,
    comments: { nodes: comments },
    ...over,
  };
}

describe('signalFromReviewThreadNode', () => {
  it('preserves the exact thread, triggering comment, and top-level REST id', () => {
    const signal = signalFromReviewThreadNode(thread([root]));

    expect(signal).toMatchObject({
      id: 'review:PRRT_thread:PRRC_root',
      kind: 'review_feedback',
      reviewThreadId: 'PRRT_thread',
      reviewCommentId: 'PRRC_root',
      reviewRootCommentId: 3_553_703_498,
      url: root.url,
    });
  });

  it('suppresses a thread whose newest comment is Hermes acknowledging the fix', () => {
    const hermesReply = {
      ...root,
      id: 'PRRC_hermes',
      databaseId: 3_553_900_001,
      body: `Addressed.\n${HERMES_REVIEW_REPLY_MARKER_PREFIX}PRRC_root -->`,
      author: { login: 'donatemate-hermes' },
    };

    expect(signalFromReviewThreadNode(thread([root, hermesReply]))).toBeNull();
  });

  it('emits a fresh signal when a reviewer follows up after Hermes replied', () => {
    const hermesReply = {
      ...root,
      id: 'PRRC_hermes',
      databaseId: 3_553_900_001,
      body: `Addressed.\n${HERMES_REVIEW_REPLY_MARKER_PREFIX}PRRC_root -->`,
      author: { login: 'donatemate-hermes' },
    };
    const followup = {
      ...root,
      id: 'PRRC_followup',
      databaseId: 3_553_900_002,
      body: 'One edge case remains.',
      createdAt: '2026-07-10T10:00:00Z',
    };

    const signal = signalFromReviewThreadNode(thread([root, hermesReply, followup]));
    expect(signal?.id).toBe('review:PRRT_thread:PRRC_followup');
    expect(signal?.reviewRootCommentId).toBe(root.databaseId);
    expect(signal?.details).not.toContain(HERMES_REVIEW_REPLY_MARKER_PREFIX);
  });

  it('ignores resolved and outdated threads', () => {
    expect(signalFromReviewThreadNode(thread([root], { isResolved: true }))).toBeNull();
    expect(signalFromReviewThreadNode(thread([root], { isOutdated: true }))).toBeNull();
  });
});
