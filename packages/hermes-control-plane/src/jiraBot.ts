/**
 * Jira write-back as the Hermes bot account. Posts comments and moves issues through the
 * workflow columns so the board reflects what the agent is doing. Uses SECRET_JIRA_BOT (the
 * dedicated hermes@ Atlassian account) so comments/transitions are attributed to Hermes;
 * falls back to SECRET_JIRA (shared read creds) if the bot secret isn't provisioned yet.
 * Best-effort — every call tolerates missing credentials and never throws into the caller.
 */
import { getSecretJson } from './secrets.js';

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

/** Render plain text (with newlines) into a minimal ADF document. */
function adf(text: string): unknown {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));
  return { version: 1, type: 'doc', content: paragraphs };
}

export async function commentOnIssue(issueKey: string, text: string): Promise<void> {
  const c = await creds();
  if (!c) return;
  try {
    await fetch(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      headers: { Authorization: `Basic ${c.auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: adf(text) }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Transition an issue to the first available transition whose target status (or transition name)
 * matches one of the supplied candidate names (case-insensitive). No-op if none match — the
 * workflow may not allow that move from the current status.
 */
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

// Canonical DonateMate workflow column names (with common synonyms) for each agent phase.
export const COLUMN = {
  inProgress: ['In Progress'],
  codeReview: ['Code Review', 'In Review', 'Review'],
  toDo: ['To Do', 'Selected for Development', 'Backlog'],
};
