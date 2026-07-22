/**
 * Read Jira issue context for the conversational layer, so Hermes can discuss a referenced
 * ticket (DM-###) knowledgeably while scoping the task. Uses the shared Atlassian credentials.
 * Best-effort: returns null if unconfigured or the issue can't be fetched.
 */
import { getSecretJson } from './secrets.js';

const SECRET_JIRA = process.env.SECRET_JIRA;
const KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const JIRA_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.JIRA_REQUEST_TIMEOUT_MS ?? 10_000));

function jiraFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS) });
}

export function findIssueKey(text: string): string | null {
  const m = (text || '').match(KEY_RE);
  return m ? m[1] : null;
}

export function adfText(node: unknown): string {
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

export interface JiraAssignmentEvent {
  issueKey: string;
  eventId: string;
  assignedAt: string;
}

export interface JiraActivityCandidate {
  issueKey: string;
  updatedAt: string;
}

export interface JiraCommentEvent {
  issueKey: string;
  eventId: string;
  createdAt: string;
  authorAccountId: string;
  text: string;
  phase: 'confirm' | 'comment';
}

interface JiraChangelogHistory {
  id?: string;
  created?: string;
  items?: Array<{ field?: string; to?: string | null }>;
}

interface JiraCommentRecord {
  id?: string;
  created?: string;
  updated?: string;
  author?: { accountId?: string };
  body?: unknown;
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * JQL used by the control-plane safety-net poller. Jira Automation can delay or suspend rule
 * execution independently of Hermes; polling recent assignee changes keeps intake operational
 * without repeatedly scanning the whole project.
 */
export function recentHermesAssignmentsJql(accountId: string, lookbackDays: number): string {
  const days = Math.max(1, Math.floor(lookbackDays));
  const account = jqlString(accountId);
  return `assignee = ${account} AND assignee CHANGED TO ${account} AFTER "-${days}d" ORDER BY updated DESC`;
}

/**
 * Narrow fast-lane query for any Jira activity on tickets currently assigned to Hermes.
 * Assignment changes update the issue too, so one inexpensive query feeds both assignment and
 * comment reconciliation. A wider five-minute safety sweep remains responsible for old outages.
 */
export function recentHermesActivityJql(accountId: string, lookbackMinutes: number): string {
  const minutes = Math.max(1, Math.floor(lookbackMinutes));
  return `assignee = ${jqlString(accountId)} AND updated >= "-${minutes}m" ORDER BY updated DESC`;
}

export function jiraCommentEventsFromRecords(
  issueKey: string,
  botAccountId: string,
  comments: JiraCommentRecord[],
  createdAfterMs = 0
): JiraCommentEvent[] {
  return comments
    .filter(
      (comment) =>
        comment.id &&
        comment.created &&
        comment.author?.accountId &&
        comment.author.accountId !== botAccountId &&
        Date.parse(comment.created) >= createdAfterMs
    )
    .map((comment) => {
      const text = adfText(comment.body).trim();
      return {
        issueKey: issueKey.toUpperCase(),
        eventId: comment.id!,
        createdAt: comment.created!,
        authorAccountId: comment.author!.accountId!,
        text,
        phase: /^\/go(?:\s|$)/i.test(text) ? ('confirm' as const) : ('comment' as const),
      };
    })
    .filter((event) => Boolean(event.text))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Select the newest changelog entry that assigned an issue to the Hermes account. */
export function latestHermesAssignmentEvent(
  issueKey: string,
  accountId: string,
  histories: JiraChangelogHistory[]
): JiraAssignmentEvent | undefined {
  return histories
    .filter(
      (history) =>
        history.id &&
        history.created &&
        history.items?.some((item) => item.field === 'assignee' && item.to === accountId)
    )
    .map((history) => ({ issueKey: issueKey.toUpperCase(), eventId: history.id!, assignedAt: history.created! }))
    .sort((a, b) => Date.parse(b.assignedAt) - Date.parse(a.assignedAt))[0];
}

async function jiraCredentials(): Promise<{ host: string; auth: string } | null> {
  if (!SECRET_JIRA) return null;
  const { host, email, token } = await getSecretJson(SECRET_JIRA);
  if (!host || !email || !token) return null;
  return { host: host.replace(/\/$/, ''), auth: Buffer.from(`${email}:${token}`).toString('base64') };
}

async function jiraJson<T>(url: URL, auth: string, operation: string): Promise<T> {
  const res = await jiraFetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`${operation} failed: Jira HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

/** Fetch the latest concrete assignee-change event for one issue. */
export async function fetchLatestHermesAssignmentEvent(
  issueKey: string,
  accountId: string
): Promise<JiraAssignmentEvent | undefined> {
  const c = await jiraCredentials();
  if (!c) throw new Error('Jira credentials are not configured for assignment reconciliation');

  const url = new URL(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`);
  url.searchParams.set('maxResults', '100');
  let page = await jiraJson<{ total?: number; values?: JiraChangelogHistory[] }>(url, c.auth, `Reading ${issueKey} changelog`);
  let histories = page.values ?? [];

  // Changelogs are returned oldest-first. Fetch the final page when an issue has more than 100
  // history entries so a recent reassignment cannot be hidden beyond the first page.
  const total = page.total ?? histories.length;
  if (total > histories.length) {
    url.searchParams.set('startAt', String(Math.max(0, total - 100)));
    page = await jiraJson(url, c.auth, `Reading latest ${issueKey} changelog page`);
    histories = page.values ?? [];
  }
  return latestHermesAssignmentEvent(issueKey, accountId, histories);
}

/**
 * Find recent, currently-active assignments to Hermes and resolve each to a stable Jira changelog
 * id. The id is used as the distributed dedupe key across both control-plane replicas.
 */
export async function fetchRecentHermesAssignmentEvents(
  accountId: string,
  lookbackDays: number
): Promise<JiraAssignmentEvent[]> {
  const c = await jiraCredentials();
  if (!c) throw new Error('Jira credentials are not configured for assignment reconciliation');

  const issueKeys: string[] = [];
  let nextPageToken: string | undefined;
  do {
    const url = new URL(`${c.host}/rest/api/3/search/jql`);
    url.searchParams.set('jql', recentHermesAssignmentsJql(accountId, lookbackDays));
    url.searchParams.set('fields', 'key');
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const page = await jiraJson<{ issues?: Array<{ key?: string }>; nextPageToken?: string }>(
      url,
      c.auth,
      'Searching recent Hermes assignments'
    );
    issueKeys.push(...(page.issues ?? []).map((issue) => issue.key).filter((key): key is string => Boolean(key)));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  const events: JiraAssignmentEvent[] = [];
  // Keep this sequential: assignment volume is low, and it avoids creating a Jira API burst when
  // a human assigns a backlog batch at once.
  for (const issueKey of [...new Set(issueKeys)]) {
    const event = await fetchLatestHermesAssignmentEvent(issueKey, accountId);
    if (event) events.push(event);
  }
  return events;
}

/** One cheap JQL request per fast-poll tick; detailed reads happen only when an issue changed. */
export async function fetchRecentHermesActivityCandidates(
  accountId: string,
  lookbackMinutes: number
): Promise<JiraActivityCandidate[]> {
  const c = await jiraCredentials();
  if (!c) throw new Error('Jira credentials are not configured for fast activity reconciliation');

  const candidates: JiraActivityCandidate[] = [];
  let nextPageToken: string | undefined;
  do {
    const url = new URL(`${c.host}/rest/api/3/search/jql`);
    url.searchParams.set('jql', recentHermesActivityJql(accountId, lookbackMinutes));
    url.searchParams.set('fields', 'updated');
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const page = await jiraJson<{
      issues?: Array<{ key?: string; fields?: { updated?: string } }>;
      nextPageToken?: string;
    }>(url, c.auth, 'Searching recent Hermes activity');
    for (const issue of page.issues ?? []) {
      if (issue.key && issue.fields?.updated) {
        candidates.push({ issueKey: issue.key.toUpperCase(), updatedAt: issue.fields.updated });
      }
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return candidates;
}

/** Fetch recent human comments newest-first from Jira, then return them in processing order. */
export async function fetchRecentJiraCommentEvents(
  issueKey: string,
  botAccountId: string,
  lookbackMinutes: number
): Promise<JiraCommentEvent[]> {
  const c = await jiraCredentials();
  if (!c) throw new Error('Jira credentials are not configured for comment reconciliation');

  const cutoff = Date.now() - Math.max(1, Math.floor(lookbackMinutes)) * 60_000;
  const comments: JiraCommentRecord[] = [];
  let startAt = 0;
  for (;;) {
    const url = new URL(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('orderBy', '-created');
    const page = await jiraJson<{ comments?: JiraCommentRecord[]; total?: number }>(
      url,
      c.auth,
      `Reading recent ${issueKey} comments`
    );
    const batch = page.comments ?? [];
    comments.push(...batch);
    const oldest = batch.reduce(
      (value, comment) => Math.min(value, comment.created ? Date.parse(comment.created) : Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY
    );
    startAt += batch.length;
    if (!batch.length || startAt >= (page.total ?? startAt) || oldest < cutoff) break;
  }
  return jiraCommentEventsFromRecords(issueKey, botAccountId, comments, cutoff);
}

/** Resolve an Automation callback to its concrete Jira comment id for cross-path deduplication. */
export async function fetchMatchingJiraCommentEvent(
  issueKey: string,
  botAccountId: string,
  phase: 'confirm' | 'comment',
  authorAccountId?: string,
  text?: string
): Promise<JiraCommentEvent | undefined> {
  const events = await fetchRecentJiraCommentEvents(issueKey, botAccountId, 24 * 60);
  const clean = (text ?? '').trim();
  const phaseMatches = events.filter((event) => event.phase === phase);
  const exactMatches = phaseMatches.filter((event) => phase === 'confirm' || !clean || event.text === clean);
  // Automation's {{comment.body}} can render differently from the ADF text returned by REST.
  // Prefer exact text, then the latest same-author event, then the latest event of this phase.
  const exactAuthorMatch = authorAccountId
    ? exactMatches.filter((event) => event.authorAccountId === authorAccountId).at(-1)
    : undefined;
  const authorMatch = authorAccountId
    ? phaseMatches.filter((event) => event.authorAccountId === authorAccountId).at(-1)
    : undefined;
  return exactAuthorMatch ?? authorMatch ?? exactMatches.at(-1) ?? phaseMatches.at(-1);
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
    const res = await jiraFetch(`${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=assignee`, {
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
    const res = await jiraFetch(
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
