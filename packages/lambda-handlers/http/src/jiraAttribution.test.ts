import { describe, expect, it } from 'vitest';
import {
  JIRA_ATTRIBUTION_PROPERTY_KEY,
  appendJiraAttribution,
  buildAttributedJiraComment,
  buildAttributedJiraIssuePayload,
  buildJiraAttribution,
  createMcpPrincipal,
  displayNameFromEmail,
  hashJiraContent,
  requireJiraActor,
} from './jiraAttribution.js';

const principal = createMcpPrincipal({
  principalId: 'user-123',
  displayName: 'Andrew Sheehy',
  actorType: 'human',
  clientName: 'Claude MCP',
  authMethod: 'oauth',
  jiraAccountId: 'jira-456',
});

describe('Jira MCP attribution', () => {
  it('builds visible and machine-readable attribution without mutating the caller body', () => {
    const source = {
      type: 'doc' as const,
      version: 1 as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original comment' }] }],
    };
    const actor = requireJiraActor(principal, 'request-789', '2026-08-31T12:00:00.000Z');

    const body = appendJiraAttribution(source, actor, 'comment.create');
    const property = buildJiraAttribution(actor, 'comment.create');

    expect(source.content).toHaveLength(1);
    expect(body.content).toHaveLength(3);
    expect(JSON.stringify(body)).toContain('Initiator:');
    expect(JSON.stringify(body)).toContain('Andrew Sheehy');
    expect(JSON.stringify(body)).toContain('Executor: Claude MCP');
    expect(JSON.stringify(body)).toContain('mcp_request-789');
    expect(property).toEqual({
      schemaVersion: 1,
      source: 'donatemate-mcp',
      action: 'comment.create',
      auditId: 'mcp_request-789',
      occurredAt: '2026-08-31T12:00:00.000Z',
      initiator: {
        id: 'user-123',
        displayName: 'Andrew Sheehy',
        type: 'human',
        authMethod: 'oauth',
        jiraAccountId: 'jira-456',
      },
      executor: { name: 'Claude MCP' },
    });
    expect(JIRA_ATTRIBUTION_PROPERTY_KEY).toBe('donatemate.mcp.attribution.v1');
  });

  it('creates an attributed description when the caller did not provide one', () => {
    const actor = requireJiraActor(principal, 'request-empty', '2026-08-31T12:00:00.000Z');
    const body = appendJiraAttribution(undefined, actor, 'issue.create');

    expect(body.content).toHaveLength(1);
    expect(JSON.stringify(body)).toContain('Created through DonateMate MCP');
  });

  it('puts attribution properties into the original Jira create requests', () => {
    const actor = requireJiraActor(principal, 'request-payload', '2026-08-31T12:00:00.000Z');
    const description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Details' }] }],
    };

    const issuePayload = buildAttributedJiraIssuePayload({ summary: 'Summary' }, description, actor);
    const commentPayload = buildAttributedJiraComment(description, actor);

    expect(issuePayload).toMatchObject({
      fields: { summary: 'Summary' },
      properties: [{ key: JIRA_ATTRIBUTION_PROPERTY_KEY }],
    });
    expect(commentPayload).toMatchObject({
      properties: [{ key: JIRA_ATTRIBUTION_PROPERTY_KEY }],
    });
    expect(JSON.stringify(issuePayload)).toContain('Created through DonateMate MCP');
    expect(JSON.stringify(commentPayload)).toContain('Submitted through DonateMate MCP');
  });

  it('fails closed when authentication did not resolve a verified actor', () => {
    expect(() => requireJiraActor(null, 'request-1')).toThrow('Jira write blocked');
    expect(createMcpPrincipal({ principalId: 'user-only' })).toBeNull();
  });

  it('derives a readable OAuth display name without exposing the email address', () => {
    expect(displayNameFromEmail('patrick.sheehy+claude@donate-mate.com')).toBe('Patrick Sheehy');
  });

  it('generates a stable content hash for the audit event', () => {
    expect(hashJiraContent({ body: 'same' })).toBe(hashJiraContent({ body: 'same' }));
    expect(hashJiraContent({ body: 'same' })).not.toBe(hashJiraContent({ body: 'different' }));
  });
});
