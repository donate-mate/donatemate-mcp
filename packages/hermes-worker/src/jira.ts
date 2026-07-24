/**
 * Read Jira issue context so the agent builds what the ticket actually describes. Uses the
 * shared Atlassian credentials (host/email/token). Best-effort: returns null if unconfigured
 * or the issue can't be fetched. (Write access to Jira is available to the agent via the
 * DonateMate MCP dm_jira_* tools.)
 */
import { getSecretJson } from './secrets.js';

const SECRET_JIRA = process.env.SECRET_JIRA;
const KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const JIRA_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.JIRA_REQUEST_TIMEOUT_MS ?? 10_000));

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

export async function fetchIssueContext(issueKey: string): Promise<string | null> {
  if (!SECRET_JIRA) return null;
  try {
    const { host, email, token } = await getSecretJson(SECRET_JIRA);
    if (!host || !email || !token) return null;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(
      `${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,labels,parent,comment`,
      {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const d = (await res.json()) as any;
    const f = d.fields || {};
    const parentKey = f.parent?.key as string | undefined;
    const parentSummary = f.parent?.fields?.summary as string | undefined;
    const parentType = f.parent?.fields?.issuetype?.name as string | undefined;
    const desc = f.description ? adfText(f.description).trim() : '';
    const comments = (f.comment?.comments || [])
      .slice(-5)
      .map((c: any) => `- ${c.author?.displayName ?? '?'}: ${adfText(c.body).trim()}`)
      .join('\n');
    return [
      `Jira ${issueKey}: ${f.summary ?? ''}`,
      `Type: ${f.issuetype?.name ?? '?'} | Status: ${f.status?.name ?? '?'}${f.labels?.length ? ` | Labels: ${f.labels.join(', ')}` : ''}`,
      ...(parentKey || parentSummary
        ? [`Parent: ${parentKey ?? '?'}${parentSummary ? ` ${parentSummary}` : ''}${parentType ? ` (${parentType})` : ''}`]
        : []),
      '',
      'Description:',
      desc || '(none)',
      ...(comments ? ['', 'Recent comments:', comments] : []),
    ].join('\n');
  } catch {
    return null;
  }
}
