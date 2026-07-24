process.env.AWS_REGION ??= 'us-east-2';

import { describe, expect, it, vi } from 'vitest';
import {
  HERMES_REVIEW_REPLY_MARKER_PREFIX,
  replyToAddressedReviewComments,
  reviewReplyMarker,
  WORKER_INSTALLATION_PERMISSIONS,
} from './github.js';
import type { ReviewReplyTarget } from './jobs.js';

const target: ReviewReplyTarget = {
  threadId: 'PRRT_thread',
  feedbackCommentId: 'PRRC_feedback',
  rootCommentId: 3_553_703_498,
  url: 'https://github.com/donate-mate/donatemate/pull/772#discussion_r3553703498',
};

function fakeOctokit(existingBodies: string[] = []) {
  const request = vi.fn().mockResolvedValue({ data: {} });
  const paginate = vi.fn().mockResolvedValue(existingBodies.map((body) => ({ body })));
  return {
    request,
    paginate,
    pulls: { listReviewComments: vi.fn() },
  };
}

describe('replyToAddressedReviewComments', () => {
  it('replies to the top-level review comment with the fix commit and marker', async () => {
    const octokit = fakeOctokit();

    const result = await replyToAddressedReviewComments(
      octokit as any,
      'donate-mate/donatemate',
      772,
      [target],
      'abc1234567890'
    );

    expect(result).toEqual({ posted: 1, alreadyPresent: 0 });
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      expect.objectContaining({
        owner: 'donate-mate',
        repo: 'donatemate',
        pull_number: 772,
        comment_id: target.rootCommentId,
        body: expect.stringContaining('abc1234'),
      })
    );
    expect(octokit.request.mock.calls[0][1].body).toContain(reviewReplyMarker(target.feedbackCommentId));
  });

  it('skips a reply already carrying the same feedback marker', async () => {
    const octokit = fakeOctokit([`Already handled\n${reviewReplyMarker(target.feedbackCommentId)}`]);

    const result = await replyToAddressedReviewComments(
      octokit as any,
      'donate-mate/donatemate',
      772,
      [target],
      'abc1234567890'
    );

    expect(result).toEqual({ posted: 0, alreadyPresent: 1 });
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it('deduplicates repeated targets from a coalesced signal batch', async () => {
    const octokit = fakeOctokit();

    const result = await replyToAddressedReviewComments(
      octokit as any,
      'donate-mate/donatemate',
      772,
      [target, { ...target }],
      'abc1234567890'
    );

    expect(result.posted).toBe(1);
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it('uses the same marker prefix consumed by the control-plane signal filter', () => {
    expect(reviewReplyMarker(target.feedbackCommentId)).toBe(
      `${HERMES_REVIEW_REPLY_MARKER_PREFIX}${target.feedbackCommentId} -->`
    );
  });
});

describe('worker GitHub installation permissions', () => {
  it('can push legitimate GitHub Actions workflow changes', () => {
    expect(WORKER_INSTALLATION_PERMISSIONS).toMatchObject({
      contents: 'write',
      workflows: 'write',
    });
  });
});
