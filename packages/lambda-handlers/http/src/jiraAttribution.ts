import { createHash } from 'crypto';

export const JIRA_ATTRIBUTION_PROPERTY_KEY = 'donatemate.mcp.attribution.v1';

export type McpActorType = 'human' | 'service';
export type McpAuthMethod = 'api-key' | 'oauth';
export type JiraAttributedAction = 'issue.create' | 'comment.create';

export interface McpPrincipal {
  principalId: string;
  displayName: string;
  actorType: McpActorType;
  clientName: string;
  authMethod: McpAuthMethod;
  jiraAccountId?: string;
}

export interface JiraActorContext extends McpPrincipal {
  auditId: string;
  occurredAt: string;
}

export interface JiraAttributionProperty {
  schemaVersion: 1;
  source: 'donatemate-mcp';
  action: JiraAttributedAction;
  auditId: string;
  occurredAt: string;
  initiator: {
    id: string;
    displayName: string;
    type: McpActorType;
    authMethod: McpAuthMethod;
    jiraAccountId?: string;
  };
  executor: {
    name: string;
  };
}

interface AdfDocument {
  type: 'doc';
  version: 1;
  content: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function cleanIdentityValue(value: unknown, maxLength = 160): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function displayNameFromEmail(email: unknown): string {
  const normalized = cleanIdentityValue(email, 320).toLowerCase();
  const localPart = normalized.split('@')[0]?.split('+')[0] || '';
  const parts = localPart.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
    .slice(0, 160);
}

export function createMcpPrincipal(input: Partial<McpPrincipal>): McpPrincipal | null {
  const principalId = cleanIdentityValue(input.principalId);
  const displayName = cleanIdentityValue(input.displayName);
  const clientName = cleanIdentityValue(input.clientName);
  const jiraAccountId = cleanIdentityValue(input.jiraAccountId);
  const actorType = input.actorType;
  const authMethod = input.authMethod;

  if (
    !principalId ||
    !displayName ||
    !clientName ||
    (actorType !== 'human' && actorType !== 'service') ||
    (authMethod !== 'api-key' && authMethod !== 'oauth')
  ) {
    return null;
  }

  return {
    principalId,
    displayName,
    actorType,
    clientName,
    authMethod,
    ...(jiraAccountId ? { jiraAccountId } : {}),
  };
}

export function requireJiraActor(
  principal: McpPrincipal | null,
  requestId: string,
  occurredAt = new Date().toISOString()
): JiraActorContext {
  if (!principal) {
    throw new Error(
      'Jira write blocked: the authenticated MCP credential does not have a verified actor identity. Reconnect with OAuth or ask an administrator to add displayName, actorType, and clientName to the API key.'
    );
  }

  const cleanRequestId = cleanIdentityValue(requestId) || createHash('sha256').update(occurredAt).digest('hex').slice(0, 24);
  return {
    ...principal,
    auditId: cleanRequestId.startsWith('mcp_') ? cleanRequestId : `mcp_${cleanRequestId}`,
    occurredAt,
  };
}

export function buildJiraAttribution(
  actor: JiraActorContext,
  action: JiraAttributedAction
): JiraAttributionProperty {
  return {
    schemaVersion: 1,
    source: 'donatemate-mcp',
    action,
    auditId: actor.auditId,
    occurredAt: actor.occurredAt,
    initiator: {
      id: actor.principalId,
      displayName: actor.displayName,
      type: actor.actorType,
      authMethod: actor.authMethod,
      ...(actor.jiraAccountId ? { jiraAccountId: actor.jiraAccountId } : {}),
    },
    executor: {
      name: actor.clientName,
    },
  };
}

export function buildAttributedJiraIssuePayload(
  fields: Record<string, unknown>,
  description: unknown,
  actor: JiraActorContext
): Record<string, unknown> {
  return {
    fields: {
      ...fields,
      description: appendJiraAttribution(description, actor, 'issue.create'),
    },
    properties: [{
      key: JIRA_ATTRIBUTION_PROPERTY_KEY,
      value: buildJiraAttribution(actor, 'issue.create'),
    }],
  };
}

export function buildAttributedJiraComment(
  body: unknown,
  actor: JiraActorContext
): Record<string, unknown> {
  return {
    body: appendJiraAttribution(body, actor, 'comment.create'),
    properties: [{
      key: JIRA_ATTRIBUTION_PROPERTY_KEY,
      value: buildJiraAttribution(actor, 'comment.create'),
    }],
  };
}

export function buildAttributedJiraTransitionCommentPlan(
  transitionId: string,
  body: unknown,
  actor: JiraActorContext
): {
  transitionPayload: Record<string, unknown>;
  commentPayload: Record<string, unknown>;
} {
  return {
    // Keep the transition and comment as separate Jira requests. Some Jira
    // workflows acknowledge an embedded comment but silently omit it.
    transitionPayload: { transition: { id: transitionId } },
    commentPayload: buildAttributedJiraComment(body, actor),
  };
}

function normalizeAdfDocument(input: unknown): AdfDocument {
  if (input === undefined || input === null) {
    return { type: 'doc', version: 1, content: [] };
  }

  if (
    typeof input !== 'object' ||
    input === null ||
    (input as { type?: unknown }).type !== 'doc' ||
    (input as { version?: unknown }).version !== 1 ||
    !Array.isArray((input as { content?: unknown }).content)
  ) {
    throw new Error('Jira attribution requires a valid ADF document');
  }

  const document = input as AdfDocument;
  return { ...document, content: [...document.content] };
}

export function appendJiraAttribution(
  input: unknown,
  actor: JiraActorContext,
  action: JiraAttributedAction
): AdfDocument {
  const document = normalizeAdfDocument(input);
  const verb = action === 'issue.create' ? 'Created' : 'Submitted';
  const actorLabel = actor.actorType === 'human' ? 'verified human' : 'verified service';
  const attributionParagraph: Record<string, unknown> = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `${verb} through DonateMate MCP. Initiator: `,
        marks: [{ type: 'em' }],
      },
      {
        type: 'text',
        text: actor.displayName,
        marks: [{ type: 'strong' }],
      },
      {
        type: 'text',
        text: ` (${actorLabel}). Executor: ${actor.clientName}. Audit ID: ${actor.auditId}.`,
        marks: [{ type: 'em' }],
      },
    ],
  };

  return {
    ...document,
    content: [
      ...document.content,
      ...(document.content.length > 0 ? [{ type: 'rule' }] : []),
      attributionParagraph,
    ],
  };
}

export function hashJiraContent(input: unknown): string {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  return createHash('sha256').update(serialized).digest('hex');
}
