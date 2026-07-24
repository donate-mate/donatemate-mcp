import { describe, expect, it, vi } from 'vitest';
import {
  jiraCommentEventsFromRecords,
  recentHermesActivityJql,
  type JiraCommentEvent,
} from './jira.js';
import { processJiraCommentEvent, reconcileJiraCommentEvents } from './jiraCommentReconciler.js';

const BOT = '712020:hermes-account';
const event = (id: string, phase: 'confirm' | 'comment' = 'comment'): JiraCommentEvent => ({
  issueKey: 'DM-1503',
  eventId: id,
  createdAt: `2026-07-20T18:20:${id.padStart(2, '0')}.000-0400`,
  authorAccountId: '712020:human',
  text: phase === 'confirm' ? '/go' : `refinement ${id}`,
  phase,
});

describe('Jira fast activity discovery', () => {
  it('uses a minute-scale current-assignee query', () => {
    expect(recentHermesActivityJql(BOT, 15)).toBe(
      `assignee = "${BOT}" AND updated >= "-15m" ORDER BY updated DESC`
    );
  });

  it('extracts ordered human comment events and classifies /go', () => {
    const events = jiraCommentEventsFromRecords(
      'dm-1503',
      BOT,
      [
        {
          id: '3',
          created: '2026-07-20T18:20:03.000-0400',
          author: { accountId: '712020:human' },
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/go now' }] }] },
        },
        {
          id: '1',
          created: '2026-07-20T18:20:01.000-0400',
          author: { accountId: '712020:human' },
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use the API' }] }] },
        },
        {
          id: '2',
          created: '2026-07-20T18:20:02.000-0400',
          author: { accountId: BOT },
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/go' }] }] },
        },
      ],
      Date.parse('2026-07-20T18:20:00.000-0400')
    );

    expect(events).toEqual([
      {
        issueKey: 'DM-1503',
        eventId: '1',
        createdAt: '2026-07-20T18:20:01.000-0400',
        authorAccountId: '712020:human',
        text: 'Use the API',
        phase: 'comment',
      },
      {
        issueKey: 'DM-1503',
        eventId: '3',
        createdAt: '2026-07-20T18:20:03.000-0400',
        authorAccountId: '712020:human',
        text: '/go now',
        phase: 'confirm',
      },
    ]);
  });
});

describe('Jira comment reconciliation', () => {
  it('deduplicates an event already claimed by a webhook or another replica', async () => {
    const process = vi.fn(async () => undefined);
    await expect(
      processJiraCommentEvent(event('1'), {
        tryClaim: async () => undefined,
        process,
        complete: async () => undefined,
        release: async () => undefined,
      })
    ).resolves.toBe(false);
    expect(process).not.toHaveBeenCalled();
  });

  it('releases a failed event and preserves comment order for the rest', async () => {
    const order: string[] = [];
    const released: string[] = [];
    const result = await reconcileJiraCommentEvents([event('1'), event('2', 'confirm')], {
      tryClaim: async (item) => ({ markerKey: `jiracomment:${item.issueKey}:${item.eventId}`, token: item.eventId }),
      process: async (item) => {
        order.push(item.eventId);
        if (item.eventId === '1') throw new Error('temporary failure');
      },
      complete: async () => undefined,
      release: async (claim) => {
        released.push(claim.markerKey);
      },
    });

    expect(order).toEqual(['1', '2']);
    expect(released).toEqual(['jiracomment:DM-1503:1']);
    expect(result).toEqual({ discovered: 2, processed: 1, skipped: 0, failed: 1 });
  });
});
