/**
 * Jira write-back as the Hermes bot account (worker side): progress comments + workflow column
 * moves as the agent runs. Uses SECRET_JIRA_BOT (the dedicated hermes@ account) so the board
 * attributes activity to Hermes; falls back to SECRET_JIRA if the bot secret isn't set yet.
 * Best-effort — never throws into the job pipeline.
 */
import { createHash } from 'node:crypto';
import { getSecretJson } from './secrets.js';
import { markdownToAdf } from './markdownAdf.js';

const DEFAULT_SECRET = process.env.SECRET_JIRA_BOT || process.env.SECRET_JIRA;
const PRIVILEGED_SECRET = process.env.SECRET_JIRA;
const MAX_COMMENT_CHARS = Number(process.env.JIRA_COMMENT_MAX_CHARS ?? 9000);

async function creds(secretName = DEFAULT_SECRET): Promise<{ host: string; auth: string } | null> {
  if (!secretName) return null;
  try {
    const { host, email, token } = await getSecretJson(secretName);
    if (!host || !email || !token) return null;
    return { host, auth: Buffer.from(`${email}:${token}`).toString('base64') };
  } catch {
    return null;
  }
}

async function jiraRequest(path: string, init: RequestInit = {}, secretName = DEFAULT_SECRET): Promise<Response | null> {
  const c = await creds(secretName);
  if (!c) return null;
  return fetch(`${c.host}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${c.auth}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/** Comment text is markdown; convert to ADF so Jira renders it (not literal `##`/`**`). */
export async function commentOnIssue(issueKey: string, markdown: string): Promise<void> {
  const c = await creds();
  if (!c) return;
  const body =
    markdown.length > MAX_COMMENT_CHARS
      ? `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n...truncated by Hermes; see the linked transcript/artifact for full details.`
      : markdown;
  try {
    const res = await fetch(`${c.host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      headers: { Authorization: `Basic ${c.auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: markdownToAdf(body) }),
    });
    if (!res.ok) {
      console.warn(`[jira] comment on ${issueKey} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[jira] comment on ${issueKey} errored: ${err instanceof Error ? err.message : String(err)}`);
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

export async function setFixVersion(issueKey: string, versionName: string): Promise<boolean> {
  if (!versionName.trim()) return false;
  const trimmedVersion = versionName.trim();
  const projectKey = issueKey.split('-')[0];
  const body = JSON.stringify({ fields: { fixVersions: [{ name: trimmedVersion }] } });
  try {
    const res = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body,
    });
    if (!res) return false;
    if (res.ok) return true;

    const text = await res.text();
    if (!/fixVersions|Version name|not valid/i.test(text)) {
      console.warn(`[jira] set fixVersion on ${issueKey} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return false;
    }

    const created = await ensureProjectVersion(projectKey, trimmedVersion);
    if (!created) {
      console.warn(`[jira] set fixVersion on ${issueKey} failed and version creation was not confirmed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return false;
    }

    const retry = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body,
    });
    if (!retry) return false;
    if (retry.ok) return true;

    if (PRIVILEGED_SECRET && PRIVILEGED_SECRET !== DEFAULT_SECRET) {
      const privilegedRetry = await jiraRequest(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        {
          method: 'PUT',
          body,
        },
        PRIVILEGED_SECRET
      );
      if (privilegedRetry?.ok) return true;
      if (privilegedRetry) {
        console.warn(
          `[jira] privileged set fixVersion retry on ${issueKey} failed: HTTP ${privilegedRetry.status} ${(await privilegedRetry.text()).slice(
            0,
            300
          )}`
        );
      }
    }

    if (!retry.ok) {
      console.warn(`[jira] set fixVersion retry on ${issueKey} failed: HTTP ${retry.status} ${(await retry.text()).slice(0, 300)}`);
      return false;
    }
  } catch (err) {
    console.warn(`[jira] set fixVersion on ${issueKey} errored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  return true;
}

async function ensureProjectVersion(projectKey: string, versionName: string): Promise<boolean> {
  if (!projectKey || !versionName) return false;
  const existing = await jiraRequest(`/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`).catch(() => null);
  if (existing?.ok) {
    const versions = (await existing.json()) as Array<{ name?: string }>;
    if (versions.some((version) => version.name === versionName)) return true;
  }

  const res = await jiraRequest('/rest/api/3/version', {
    method: 'POST',
    body: JSON.stringify({ project: projectKey, name: versionName }),
  });
  if (!res) return false;
  if (res.ok) return true;
  const text = await res.text();
  if (/already exists|A version with this name/i.test(text)) return true;

  if (PRIVILEGED_SECRET && PRIVILEGED_SECRET !== DEFAULT_SECRET && /permission|does not exist|forbidden|unauthor/i.test(text)) {
    const privileged = await jiraRequest(
      '/rest/api/3/version',
      {
        method: 'POST',
        body: JSON.stringify({ project: projectKey, name: versionName }),
      },
      PRIVILEGED_SECRET
    );
    if (privileged?.ok) return true;
    if (privileged) {
      const privilegedText = await privileged.text();
      if (/already exists|A version with this name/i.test(privilegedText)) return true;
      console.warn(
        `[jira] privileged create version ${projectKey}/${versionName} failed: HTTP ${privileged.status} ${privilegedText.slice(0, 300)}`
      );
    }
  }

  console.warn(`[jira] create version ${projectKey}/${versionName} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return false;
}

export async function assignIssue(issueKey: string, accountId: string): Promise<boolean> {
  if (!accountId.trim()) return false;
  try {
    const res = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
      method: 'PUT',
      body: JSON.stringify({ accountId: accountId.trim() }),
    });
    if (!res) return false;
    if (!res.ok) {
      console.warn(`[jira] assign ${issueKey} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[jira] assign ${issueKey} errored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function normalizeDedupeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function deploymentFailureLabel(value: string): string {
  const normalized = normalizeDedupeText(value);
  const hash = createHash('sha256').update(normalized || 'unknown-deployment-failure').digest('hex').slice(0, 16);
  return `deploy-block-${hash}`;
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function searchIssues(jql: string, fields = 'summary,status,labels,description'): Promise<Array<{ key: string; fields?: any }>> {
  const res = await jiraRequest(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=50`);
  if (!res) return [];
  if (!res.ok) {
    console.warn(`[jira] search failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return [];
  }
  const body = (await res.json()) as { issues?: Array<{ key: string; fields?: any }> };
  return body.issues ?? [];
}

function issueContainsText(issue: { fields?: any }, needle: string): boolean {
  if (!needle) return false;
  return JSON.stringify(issue.fields?.description ?? '').toLowerCase().includes(needle);
}

async function addLabels(issueKey: string, labels: string[]): Promise<void> {
  const uniqueLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!uniqueLabels.length) return;
  const res = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ update: { labels: uniqueLabels.map((label) => ({ add: label })) } }),
  });
  if (res && !res.ok) {
    console.warn(`[jira] add labels to ${issueKey} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function linkIssues(sourceIssueKey: string, defectKey: string): Promise<void> {
  if (sourceIssueKey === defectKey) return;
  const res = await jiraRequest('/rest/api/3/issueLink', {
    method: 'POST',
    body: JSON.stringify({
      type: { name: 'Relates' },
      inwardIssue: { key: sourceIssueKey },
      outwardIssue: { key: defectKey },
    }),
  });
  if (res && !res.ok) {
    const text = await res.text();
    if (!/already|exist|duplicate/i.test(text)) {
      console.warn(`[jira] link defect ${defectKey} to ${sourceIssueKey} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
  }
}

async function findExistingDeploymentDefect(projectKey: string, dedupeLabel: string, dedupeText: string): Promise<string | null> {
  const labelJql = [
    `project = ${projectKey}`,
    'labels = deployment-failure',
    `labels = "${escapeJqlString(dedupeLabel)}"`,
  ].join(' AND ') + ' ORDER BY created ASC';
  const labeled = await searchIssues(labelJql, 'summary,status,labels');
  if (labeled[0]?.key) return labeled[0].key;

  const legacyJql = [
    `project = ${projectKey}`,
    'labels = deployment-failure',
    'labels = hermes',
  ].join(' AND ') + ' ORDER BY created ASC';
  const legacy = await searchIssues(legacyJql);
  return legacy.find((issue) => issueContainsText(issue, dedupeText))?.key ?? null;
}

export async function createLinkedDefect(input: {
  sourceIssueKey: string;
  summary: string;
  description: string;
  labels?: string[];
  dedupeKey?: string;
}): Promise<string | null> {
  const projectKey = input.sourceIssueKey.split('-')[0];
  const dedupeText = normalizeDedupeText(input.dedupeKey ?? input.description);
  const dedupeLabel = deploymentFailureLabel(dedupeText);
  const labels = [...new Set(['hermes', 'deployment-failure', dedupeLabel, ...(input.labels ?? [])])];
  const existingKey = await findExistingDeploymentDefect(projectKey, dedupeLabel, dedupeText).catch((err) => {
    console.warn(`[jira] deployment defect dedupe search errored: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (existingKey) {
    await addLabels(existingKey, [dedupeLabel]);
    await linkIssues(input.sourceIssueKey, existingKey);
    return existingKey;
  }

  const issueTypes = ['Defect', 'Bug', 'Improve Bug'];
  let createdKey: string | null = null;

  for (const issueType of issueTypes) {
    const res = await jiraRequest('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: input.summary.slice(0, 255),
          description: markdownToAdf(input.description),
          issuetype: { name: issueType },
          labels,
        },
      }),
    }).catch((err) => {
      console.warn(`[jira] create defect errored: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!res) return null;
    if (res.ok) {
      const body = (await res.json()) as { key?: string };
      createdKey = body.key ?? null;
      break;
    }
    const text = await res.text();
    if (!/issue type|issuetype/i.test(text)) {
      console.warn(`[jira] create defect failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return null;
    }
  }

  if (!createdKey) return null;

  await linkIssues(input.sourceIssueKey, createdKey).catch((err) => {
    console.warn(`[jira] link defect ${createdKey} to ${input.sourceIssueKey} errored: ${err instanceof Error ? err.message : String(err)}`);
  });

  return createdKey;
}

export const COLUMN = {
  inProgress: ['In Progress'],
  waitingCi: ['Waiting CI', 'Waiting for CI', 'Code Review', 'In Review', 'Review'],
  codeReview: ['Code Review', 'In Review', 'Review'],
  qa: ['QA', 'In QA', 'Testing', 'Ready for QA', 'Release QA'],
  blocked: ['Blocked For Development', 'Blocked for QA', 'Blocked', 'On Hold'],
  toDo: ['To Do', 'Selected for Development', 'Backlog'],
  done: ['Done', 'Complete', 'Completed'],
};

/** The issue key for a job that originated from Jira (source "jira:DM-123"), else null. */
export function jiraIssueKey(source: string | undefined): string | null {
  return source?.startsWith('jira:') ? source.slice('jira:'.length) : null;
}
