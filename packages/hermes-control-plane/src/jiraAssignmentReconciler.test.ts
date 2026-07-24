import { describe, expect, it, vi } from 'vitest';
import {
  latestHermesAssignmentEvent,
  recentHermesAssignmentsJql,
  type JiraAssignmentEvent,
} from './jira.js';
import { processJiraAssignmentEvent, reconcileJiraAssignmentEvents } from './jiraAssignmentReconciler.js';

const BOT = '712020:hermes-account';
const event = (issueKey: string, eventId: string): JiraAssignmentEvent => ({
  issueKey,
  eventId,
  assignedAt: `2026-07-20T17:48:${eventId.padStart(2, '0')}.000-0400`,
});

describe('Jira assignment event discovery', () => {
  it('searches only current, recent assignments to the Hermes account', () => {
    expect(recentHermesAssignmentsJql(BOT, 7)).toBe(
      `assignee = "${BOT}" AND assignee CHANGED TO "${BOT}" AFTER "-7d" ORDER BY updated DESC`
    );
  });

  it('selects the newest matching assignee changelog event', () => {
    expect(
      latestHermesAssignmentEvent('dm-1503', BOT, [
        {
          id: '10',
          created: '2026-07-18T10:00:00.000-0400',
          items: [{ field: 'assignee', to: BOT }],
        },
        {
          id: '11',
          created: '2026-07-19T10:00:00.000-0400',
          items: [{ field: 'summary', to: null }],
        },
        {
          id: '12',
          created: '2026-07-20T10:00:00.000-0400',
          items: [{ field: 'assignee', to: BOT }],
        },
      ])
    ).toEqual({ issueKey: 'DM-1503', eventId: '12', assignedAt: '2026-07-20T10:00:00.000-0400' });
  });
});

describe('Jira assignment reconciliation', () => {
  it('does not process an event another replica already claimed', async () => {
    const process = vi.fn(async () => undefined);
    const processed = await processJiraAssignmentEvent(event('DM-1503', '1'), {
      tryClaim: async () => undefined,
      process,
      complete: async () => undefined,
      release: async () => undefined,
    });

    expect(processed).toBe(false);
    expect(process).not.toHaveBeenCalled();
  });

  it('completes a successful claim exactly once', async () => {
    const claim = { markerKey: 'jiraassignment:DM-1503:1', token: 'claim-1' };
    const process = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      processJiraAssignmentEvent(event('DM-1503', '1'), {
        tryClaim: async () => claim,
        process,
        complete,
        release,
      })
    ).resolves.toBe(true);
    expect(process).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(claim);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a failed claim and continues processing the rest of the batch', async () => {
    const released: string[] = [];
    const completed: string[] = [];
    const failures: string[] = [];
    const events = [event('DM-1503', '1'), event('DM-1556', '2')];

    const result = await reconcileJiraAssignmentEvents(
      events,
      {
        tryClaim: async (item) => ({ markerKey: `jiraassignment:${item.issueKey}:${item.eventId}`, token: item.eventId }),
        process: async (item) => {
          if (item.issueKey === 'DM-1503') throw new Error('temporary Jira failure');
        },
        complete: async (claim) => {
          completed.push(claim.markerKey);
        },
        release: async (claim) => {
          released.push(claim.markerKey);
        },
      },
      (item) => failures.push(item.issueKey)
    );

    expect(result).toEqual({ discovered: 2, processed: 1, skipped: 0, failed: 1 });
    expect(released).toEqual(['jiraassignment:DM-1503:1']);
    expect(completed).toEqual(['jiraassignment:DM-1556:2']);
    expect(failures).toEqual(['DM-1503']);
  });
});
