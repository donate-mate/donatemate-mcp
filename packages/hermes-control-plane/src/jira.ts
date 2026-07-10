/**
 * Read Jira issue context for the conversational layer, so Hermes can discuss a referenced
 * ticket (DM-###) knowledgeably while scoping the task. Uses the shared Atlassian credentials.
 * Best-effort: returns null if unconfigured or the issue can't be fetched.
 */
import { getSecretJson } from './secrets.js';

const SECRET_JIRA = process.env.SECRET_JIRA;
const KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export function findIssueKey(text: string): string | null {
  const m = (text || '').match(KEY_RE);
  return m ? m[1] : null;
}

function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  const sep = n.type === 'paragraph' || n.type === 'heading' ? '\n' : '';
  return (Array.isArray(n.content) ? n.content.map(adfText).join('') : '') + sep;
}

export interface JiraIssue {
  summary: string;
  labels: string[];
  status: string;
  issueType: string;
  parentKey?: string;
  parentSummary?: string;
  context: string; // human-readable block (summary + type + description + recent comments)
}

/**
 * The accountId of the issue's current assignee. Distinguishes:
 *   - `undefined` → could NOT determine (unconfigured / Jira unreachable) → callers should fail open.
 *   - `null`      → fetched successfully and the issue is genuinely UNASSIGNED.
 *   - string      → the assignee's accountId.
 * Used to stop making follow-up commits once a ticket is unassigned from Hermes.
 */
export async function getIssueAssigneeAccountId(issueKey: string): Promise<string | null | undefined> {
  if (!SECRET_JIRA) return undefined;
  try {
    const { host, email, token } = await getSecretJson(SECRET_JIRA);
    if (!host || !email || !token) return undefined;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(`${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=assignee`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const d = (await res.json()) as any;
    return (d.fields?.assignee?.accountId as string | undefined) ?? null;
  } catch {
    return undefined;
  }
}

/** Fetch an issue's structured fields plus a readable context block (used for routing + planning). */
export async function fetchIssue(issueKey: string): Promise<JiraIssue | null> {
  if (!SECRET_JIRA) return null;
  try {
    const { host, email, token } = await getSecretJson(SECRET_JIRA);
    if (!host || !email || !token) return null;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(
      `${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,labels,parent,comment`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const d = (await res.json()) as any;
    const f = d.fields || {};
    const summary = f.summary ?? '';
    const labels: string[] = Array.isArray(f.labels) ? f.labels : [];
    const status = f.status?.name ?? '?';
    const issueType = f.issuetype?.name ?? '?';
    const parentKey = f.parent?.key as string | undefined;
    const parentSummary = f.parent?.fields?.summary as string | undefined;
    const parentType = f.parent?.fields?.issuetype?.name as string | undefined;
    const desc = f.description ? adfText(f.description).trim() : '';
    const comments = (f.comment?.comments || [])
      .slice(-5)
      .map((c: any) => `- ${c.author?.displayName ?? '?'}: ${adfText(c.body).trim()}`)
      .join('\n');
    const context = [
      `Jira ${issueKey}: ${summary}`,
      `Type: ${issueType} | Status: ${status}${labels.length ? ` | Labels: ${labels.join(', ')}` : ''}`,
      ...(parentKey || parentSummary
        ? [`Parent: ${parentKey ?? '?'}${parentSummary ? ` ${parentSummary}` : ''}${parentType ? ` (${parentType})` : ''}`]
        : []),
      '',
      'Description:',
      desc || '(none)',
      ...(comments ? ['', 'Recent comments:', comments] : []),
    ].join('\n');
    return { summary, labels, status, issueType, parentKey, parentSummary, context };
  } catch {
    return null;
  }
}

export async function fetchIssueContext(issueKey: string): Promise<string | null> {
  const issue = await fetchIssue(issueKey);
  return issue ? issue.context : null;
}
