/**
 * Read Jira issue context so the agent builds what the ticket actually describes. Uses the
 * shared Atlassian credentials (host/email/token). Best-effort: returns null if unconfigured
 * or the issue can't be fetched. (Write access to Jira is available to the agent via the
 * DonateMate MCP dm_jira_* tools.)
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

export async function fetchIssueContext(issueKey: string): Promise<string | null> {
  if (!SECRET_JIRA) return null;
  try {
    const { host, email, token } = await getSecretJson(SECRET_JIRA);
    if (!host || !email || !token) return null;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(
      `${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,labels,comment`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const d = (await res.json()) as any;
    const f = d.fields || {};
    const desc = f.description ? adfText(f.description).trim() : '';
    const comments = (f.comment?.comments || [])
      .slice(-5)
      .map((c: any) => `- ${c.author?.displayName ?? '?'}: ${adfText(c.body).trim()}`)
      .join('\n');
    return [
      `Jira ${issueKey}: ${f.summary ?? ''}`,
      `Type: ${f.issuetype?.name ?? '?'} | Status: ${f.status?.name ?? '?'}${f.labels?.length ? ` | Labels: ${f.labels.join(', ')}` : ''}`,
      '',
      'Description:',
      desc || '(none)',
      ...(comments ? ['', 'Recent comments:', comments] : []),
    ].join('\n');
  } catch {
    return null;
  }
}
