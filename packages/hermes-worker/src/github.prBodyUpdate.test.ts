process.env.AWS_REGION ??= 'us-east-2';

import { describe, expect, it, vi } from 'vitest';
import {
  extractOutcomeReport,
  feedbackRequestsPrBodyUpdate,
  followupReportsFeedbackAlreadyAddressed,
  validatePrBody,
} from './contract.js';
import {
  HERMES_OUTCOME_REPORT_END,
  HERMES_OUTCOME_REPORT_START,
  replacePullRequestOutcomeReport,
  requestReReviewFromChangeRequesters,
  waitForPullRequestBodyPropagation,
} from './github.js';

const report = (rootCause: string) => `## Root cause

${rootCause}

## Evidence

Evidence.

## Verification

Verification.

## Blast radius

Blast radius.

## Data repair

None.

## Deferred

An evidence gate remains.`;

describe('metadata-only PR review follow-ups', () => {
  it('only activates for explicit PR-description feedback', () => {
    expect(feedbackRequestsPrBodyUpdate('Update the PR body to match the actual diff.')).toBe(true);
    expect(feedbackRequestsPrBodyUpdate('The live merge record is stale.')).toBe(true);
    expect(feedbackRequestsPrBodyUpdate('Fix the failing repository test.')).toBe(false);
  });

  it('only accepts explicit already-addressed no-op follow-ups', () => {
    expect(
      followupReportsFeedbackAlreadyAddressed(
        'No file edits were needed in this checkout; the reviewed fixture is already corrected.'
      )
    ).toBe(true);
    expect(
      followupReportsFeedbackAlreadyAddressed(
        'The requested change has already been addressed on the current branch.'
      )
    ).toBe(true);
    expect(
      followupReportsFeedbackAlreadyAddressed(
        'I could not determine the correct fix. No changes were made.'
      )
    ).toBe(false);
  });

  it('extracts a complete outcome report from a backward-compatible final message', () => {
    const extracted = extractOutcomeReport(`No source edit was required.\n\n${report('Corrected cause.')}`);

    expect(extracted).toBeTruthy();
    expect(validatePrBody(extracted ?? '')).toEqual({ ok: true, missing: [] });
    expect(extracted).not.toContain('No source edit was required');
  });

  it('replaces a legacy report while retaining task provenance and gate results', () => {
    const current = [
      'Automated PR by **Hermes** (job `job-1`).',
      '',
      '**Task**',
      '> Preserve this task.',
      '',
      '---',
      '',
      report('Stale cause.'),
      '',
      '---',
      '',
      '**Pre-commit gate:** passed',
    ].join('\n');

    const updated = replacePullRequestOutcomeReport(current, report('Corrected cause.'));

    expect(updated).toContain('> Preserve this task.');
    expect(updated).toContain('**Pre-commit gate:** passed');
    expect(updated).toContain('Corrected cause.');
    expect(updated).not.toContain('Stale cause.');
    expect(updated.match(new RegExp(HERMES_OUTCOME_REPORT_START, 'g'))).toHaveLength(1);
    expect(updated.match(new RegExp(HERMES_OUTCOME_REPORT_END, 'g'))).toHaveLength(1);
  });

  it('uses stable markers for idempotent later report updates', () => {
    const first = replacePullRequestOutcomeReport('Task provenance.', report('First cause.'));
    const second = replacePullRequestOutcomeReport(first, report('Second cause.'));

    expect(second).toContain('Task provenance.');
    expect(second).toContain('Second cause.');
    expect(second).not.toContain('First cause.');
    expect(second.match(new RegExp(HERMES_OUTCOME_REPORT_START, 'g'))).toHaveLength(1);
  });

  it('re-requests a changes-requesting reviewer after a body-only update', async () => {
    const octokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: { requested_reviewers: [] } }),
        listReviews: vi.fn(),
        requestReviewers: vi.fn().mockResolvedValue({ data: {} }),
      },
      paginate: vi.fn().mockResolvedValue([
        { user: { login: 'reviewer', type: 'User' }, state: 'CHANGES_REQUESTED' },
      ]),
    };

    await expect(
      requestReReviewFromChangeRequesters(octokit as any, 'donate-mate/donatemate', 1049)
    ).resolves.toEqual(['reviewer']);
    expect(octokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ['reviewer'] })
    );
  });

  it('waits for the updated body to be readable twice before allowing re-review', async () => {
    const expectedBody = replacePullRequestOutcomeReport(
      'Task provenance.',
      report('Corrected cause.')
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { body: 'Task provenance.' } })
      .mockResolvedValueOnce({ data: { body: expectedBody } })
      .mockResolvedValueOnce({ data: { body: expectedBody } });
    const octokit = { pulls: { get } };

    await expect(
      waitForPullRequestBodyPropagation(
        octokit as any,
        'donate-mate/donatemate',
        1049,
        expectedBody,
        { attempts: 3, initialDelayMs: 0, pollDelayMs: 0, stableDelayMs: 0, sleep }
      )
    ).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
