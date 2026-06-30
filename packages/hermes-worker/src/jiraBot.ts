/**
 * Jira write-back as the Hermes bot account (worker side): progress comments + workflow column
 * moves as the agent runs. Uses SECRET_JIRA_BOT (the dedicated hermes@ account) so the board
 * attributes activity to Hermes; falls back to SECRET_JIRA if the bot secret isn't set yet.
 * Best-effort — never throws into the job pipeline.
 */
import { getSecretJson } from './secrets.js';
import { markdownToAdf } from './markdownAdf.js';

const SECRET = process.env.SECRET_JIRA_BOT || process.env.SECRET_JIRA;

async function creds(): Promise<{ host: string; auth: string } | null> {
  if (!SECRET) return null;
  try {
    const { host, email, token } = await getSecretJson(SECRET);
    if (!host || !email || !token) return null;
    return { host, auth: Buffer.from(`${email}:${token}`).toString('base64') };
  } catch {
    return null;
  }
}

/** Comment text is markdown; convert to ADF so Jira renders it (not literal `##`/`**`). */
export async function commentOnIssue(issueKey: string, markdown: string): Promise<void> {
  const c = await creds();
  if (!c) return;
  try {
    await fetch(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      headers: { Authorization: `Basic ${c.auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: markdownToAdf(markdown) }),
    });
  } catch {
    /* best-effort */
  }
}

export async function transitionIssue(issueKey: string, candidates: string[]): Promise<boolean> {
  const c = await creds();
  if (!c) return false;
  try {
    const want = candidates.map((s) => s.toLowerCase());
    const res = await fetch(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      headers: { Authorization: `Basic ${c.auth}`, Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { transitions?: Array<{ id: string; name?: string; to?: { name?: string } }> };
    const match = (data.transitions || []).find(
      (t) => want.includes((t.to?.name || '').toLowerCase()) || want.includes((t.name || '').toLowerCase())
    );
    if (!match) return false;
    await fetch(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      headers: { Authorization: `Basic ${c.auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return true;
  } catch {
    return false;
  }
}

export const COLUMN = {
  inProgress: ['In Progress'],
  codeReview: ['Code Review', 'In Review', 'Review'],
  toDo: ['To Do', 'Selected for Development', 'Backlog'],
};

/** The issue key for a job that originated from Jira (source "jira:DM-123"), else null. */
export function jiraIssueKey(source: string | undefined): string | null {
  return source?.startsWith('jira:') ? source.slice('jira:'.length) : null;
}
