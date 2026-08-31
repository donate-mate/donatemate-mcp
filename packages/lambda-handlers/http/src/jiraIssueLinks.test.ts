import { describe, expect, it } from 'vitest';
import { buildJiraIssueLinkRequest } from './jiraIssueLinks.js';

describe('buildJiraIssueLinkRequest', () => {
  it('maps the source to Jira outwardIssue and defaults the relationship to Blocks', () => {
    expect(buildJiraIssueLinkRequest({
      sourceIssueKey: ' DM-4349 ',
      targetIssueKey: ' DM-2398 ',
    })).toEqual({
      sourceIssueKey: 'DM-4349',
      targetIssueKey: 'DM-2398',
      linkType: 'Blocks',
      payload: {
        type: { name: 'Blocks' },
        outwardIssue: { key: 'DM-4349' },
        inwardIssue: { key: 'DM-2398' },
      },
    });
  });

  it('supports a configured link type', () => {
    expect(buildJiraIssueLinkRequest({
      sourceIssueKey: 'DM-4350',
      targetIssueKey: 'DM-2398',
      linkType: 'Relates',
    }).payload).toEqual({
      type: { name: 'Relates' },
      outwardIssue: { key: 'DM-4350' },
      inwardIssue: { key: 'DM-2398' },
    });
  });

  it('accepts the legacy outward/inward argument names used by older agents', () => {
    expect(buildJiraIssueLinkRequest({
      outwardIssueKey: 'DM-6106',
      inwardIssueKey: 'DM-6105',
      linkType: 'Duplicate',
    })).toMatchObject({
      sourceIssueKey: 'DM-6106',
      targetIssueKey: 'DM-6105',
      linkType: 'Duplicate',
    });
  });

  it.each([
    [{ targetIssueKey: 'DM-2398' }, 'sourceIssueKey and targetIssueKey are required'],
    [{ sourceIssueKey: 'DM-4349' }, 'sourceIssueKey and targetIssueKey are required'],
    [{ sourceIssueKey: 'DM-4349', targetIssueKey: 'dm-4349' }, 'must identify different issues'],
    [{ sourceIssueKey: 'DM-4349', targetIssueKey: 'DM-2398', linkType: ' ' }, 'linkType must not be empty'],
    [{
      sourceIssueKey: 'DM-4349',
      outwardIssueKey: 'DM-4350',
      targetIssueKey: 'DM-2398',
    }, 'sourceIssueKey and outwardIssueKey must identify the same issue'],
  ])('rejects invalid input %#', (input, message) => {
    expect(() => buildJiraIssueLinkRequest(input)).toThrow(message);
  });
});
