/**
 * GitHub App helpers for PR monitoring. The control plane uses these to verify GitHub webhooks,
 * inspect CI/check state, and read unresolved review threads without invoking the coding agent.
 */
import crypto from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getSecretJson } from './secrets.js';
import type { PrSignal, PrWatch } from './prWatch.js';
import {
  listReviewThreadResolutionEvidence,
  type ReviewLessonCandidate,
  type ReviewThreadResolutionEvidence,
} from './reviewLearning.js';

const SECRET_GITHUB_APP = process.env.SECRET_GITHUB_APP!;

export interface GitHubAuth {
  token: string;
  octokit: Octokit;
}

/**
 * The installation REST budget is 5,000 requests/hour and the reconcile loop used to blow through it
 * — it re-fetched, on every 5-minute tick, data that cannot change: the file list of a given commit
 * and the annotations of a completed check run. Once the budget was gone every call 403'd,
 * collectPrSnapshot threw for every watch, and the whole monitor silently stopped. So: key these by
 * something immutable (a head sha, a check-run id) and serve them from memory.
 */
function immutableCache<T>(maxEntries: number) {
  const entries = new Map<string, T>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key); // re-insert to keep the map in LRU order
      entries.set(key, hit);
      return hit;
    }
    const value = await load();
    entries.set(key, value);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    return value;
  };
}

const changedFilesCache = immutableCache<string[]>(500);
const annotationsCache = immutableCache<string>(1000);

// Worker replies include this hidden marker. When it is the newest message in an unresolved
// thread, the feedback has already been handled and must not become a new signal merely because
// Hermes's own reply changed the thread's last-comment id.
export const HERMES_REVIEW_REPLY_MARKER_PREFIX = '<!-- hermes-review-addressed:';
const HERMES_GITHUB_LOGIN = (process.env.HERMES_GITHUB_LOGIN ?? 'donatemate-hermes')
  .trim()
  .toLowerCase()
  .replace(/\[bot\]$/, '');

function isHermesReviewComment(comment: any): boolean {
  const login = String(comment?.author?.login ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
  return Boolean(login && login === HERMES_GITHUB_LOGIN);
}

/** A rate-limit 403/429 from GitHub, as opposed to a permissions 403. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as {
    status?: number;
    message?: string;
    code?: string;
    response?: { headers?: Record<string, string | number | undefined> };
  };
  if (!e) return false;
  if (e.status === 429) return true;
  const headers = e.response?.headers ?? {};
  if (
    e.status === 403 &&
    (String(headers['x-ratelimit-remaining'] ?? '') === '0' ||
      headers['retry-after'] !== undefined)
  ) {
    return true;
  }
  const message = String(e.message ?? '');
  const rateLimited = /rate limit|secondary rate|quota (?:was )?exceeded/i.test(message);
  if (/RATE_?LIMIT/i.test(String(e.code ?? ''))) return true;
  if (!rateLimited) return false;
  return e.status === 403 || /^GitHub GraphQL(?::|\s+\d+:)/i.test(message);
}

/**
 * Remaining REST calls in the installation's hourly budget. `GET /rate_limit` is itself free, so the
 * reconcile loop can cheaply refuse to start a sweep it cannot finish.
 */
export async function remainingRestBudget(repo: string): Promise<number> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const res = await octokit.request('GET /rate_limit');
    return Number(res.data?.resources?.core?.remaining ?? Number.POSITIVE_INFINITY);
  } catch {
    return Number.POSITIVE_INFINITY; // fail open — never let a budget probe stop the monitor
  }
}

export interface PrSnapshot {
  repo: string;
  prNumber: number;
  prUrl: string;
  headBranch: string;
  headSha: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
  mergeable?: boolean | null;
  mergeableState?: string;
  baseBranch: string;
  baseSha: string;
  mergeCommitSha?: string | null;
  signals: PrSignal[];
  /** Accepted-feedback candidates. They become durable only in the merged-PR reconcile branch. */
  reviewLessons: ReviewLessonCandidate[];
  labels: string[];
}

export interface WorkflowRunSummary {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  htmlUrl?: string | null;
  headSha?: string;
  createdAt?: string | null;
}

export async function verifyGitHubSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<boolean> {
  const { webhookSecret, sharedSecret } = await getSecretJson(SECRET_GITHUB_APP);
  const secret = webhookSecret || sharedSecret;
  if (!secret) return false;

  const sig = String(headers['x-hub-signature-256'] ?? '');
  if (!sig.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

// Installation tokens are valid for an hour. Minting one is itself a GitHub API call, and every
// helper in this file starts by calling getInstallationAuth — including once per peer PR inside the
// overlap scan — so re-minting per call multiplied our API usage by the number of helper calls.
// Cache per repo and re-mint a few minutes before expiry.
const authCache = new Map<string, { auth: GitHubAuth; expiresAt: number }>();
const AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function getInstallationAuth(repoFullName: string): Promise<GitHubAuth> {
  const repoName = repoFullName.split('/')[1];
  const cached = authCache.get(repoFullName);
  if (cached && cached.expiresAt - AUTH_REFRESH_MARGIN_MS > Date.now()) return cached.auth;

  const { appId, installationId, privateKey } = await getSecretJson(SECRET_GITHUB_APP);
  if (!appId || !installationId || !privateKey) {
    throw new Error('GitHub App credentials not configured in Secrets Manager');
  }
  const auth = createAppAuth({ appId, installationId, privateKey });
  const { token, expiresAt } = await auth({
    type: 'installation',
    repositoryNames: repoName ? [repoName] : undefined,
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
      actions: 'read',
      metadata: 'read',
    },
  });
  const value: GitHubAuth = { token, octokit: new Octokit({ auth: token }) };
  const expiryMs = Date.parse(String(expiresAt));
  authCache.set(repoFullName, {
    auth: value,
    expiresAt: Number.isFinite(expiryMs) ? expiryMs : Date.now() + 55 * 60 * 1000,
  });
  return value;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo full name: ${repo}`);
  return { owner, name };
}

async function ensureRepositoryLabel(octokit: Octokit, repo: string, label: string): Promise<void> {
  const { owner, name } = splitRepo(repo);
  const params = { owner, repo: name, name: label };
  try {
    await octokit.issues.getLabel(params);
  } catch (err: any) {
    if (err?.status !== 404) throw err;
    await octokit.issues
      .createLabel({
        ...params,
        color: '0e8a16',
        description: 'Deploy this frontend PR to the dev test build.',
      })
      .catch((createErr: any) => {
        // Concurrent reconcile tasks may race to create the same repo label.
        if (createErr?.status !== 422) throw createErr;
      });
  }
}

export async function ensurePullRequestLabels(repo: string, pullNumber: number, labels: string[]): Promise<void> {
  const uniqueLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!uniqueLabels.length) return;

  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  await Promise.all(uniqueLabels.map((label) => ensureRepositoryLabel(octokit, repo, label)));
  await octokit.issues.addLabels({ owner, repo: name, issue_number: pullNumber, labels: uniqueLabels });
}

// The git identity the worker commits under (packages/hermes-worker cloneRepo sets user.email).
const HERMES_GIT_EMAIL = (process.env.HERMES_GIT_EMAIL || 'hermes@donate-mate.com').toLowerCase();

/**
 * True when the given commit was authored/committed by Hermes itself (vs. a human push). Used to
 * auto-unblock a PR only when a HUMAN advances it. Best-effort: on any error returns true (assume
 * Hermes) so we never mistakenly unblock/loop on our own commits.
 */
export async function isHermesCommit(repo: string, sha: string): Promise<boolean> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    const { data } = await octokit.repos.getCommit({ owner, repo: name, ref: sha });
    const authorEmail = (data.commit?.author?.email || '').toLowerCase();
    const committerEmail = (data.commit?.committer?.email || '').toLowerCase();
    const authorLogin = (data.author?.login || '').toLowerCase();
    return (
      authorEmail === HERMES_GIT_EMAIL ||
      committerEmail === HERMES_GIT_EMAIL ||
      authorLogin.includes('hermes') // the GitHub App bot identity, e.g. donatemate-hermes[bot]
    );
  } catch {
    return true;
  }
}

/**
 * Changed files for a PR. Pass `headSha` whenever the caller knows it: the file list of a commit is
 * immutable, so it is then served from cache instead of costing up to 10 REST calls on every tick.
 */
export async function listPullRequestChangedFiles(repo: string, pullNumber: number, headSha?: string): Promise<string[]> {
  const load = async (): Promise<string[]> => {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    const files: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await octokit.pulls.listFiles({ owner, repo: name, pull_number: pullNumber, per_page: 100, page });
      files.push(...res.data.map((file) => file.filename));
      if (res.data.length < 100) break;
    }
    return files;
  };
  if (!headSha) return load();
  return changedFilesCache(`${repo}#${pullNumber}@${headSha}`, load);
}

// --- WS5 --- Post a comment on a PR (best-effort; never throws into the caller). Uses the
// issues.createComment endpoint since a PR is an issue for comment purposes.
export async function commentOnPullRequest(repo: string, prNumber: number, body: string): Promise<boolean> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    await octokit.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
    return true;
  } catch (err) {
    console.warn(`[github] comment on ${repo}#${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Re-request review from everyone whose latest review was CHANGES_REQUESTED and who is not already
 * on the pending-reviewer list. GitHub keeps `reviewDecision: CHANGES_REQUESTED` until the same
 * reviewer submits a NEW review, and a fixed PR does not re-enter their queue on its own — so
 * without this a green PR whose feedback Hermes already addressed waits forever. Returns the logins
 * we re-pinged. Fail-open: never throws.
 */
export async function requestReReviewFromChangeRequesters(repo: string, prNumber: number): Promise<string[]> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    const pr = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const alreadyPending = new Set(
      (pr.data.requested_reviewers ?? []).map((r) => String((r as { login?: string }).login ?? '').toLowerCase())
    );

    const reviews = await octokit.paginate(octokit.pulls.listReviews, { owner, repo: name, pull_number: prNumber, per_page: 100 });
    // Latest review per human reviewer wins — an author who requested changes then approved is done.
    const latest = new Map<string, string>();
    for (const review of reviews) {
      const login = review.user?.login;
      const state = String(review.state ?? '').toUpperCase();
      if (!login || review.user?.type === 'Bot') continue;
      if (state === 'COMMENTED') continue; // a plain comment does not change a reviewer's decision
      latest.set(login, state);
    }

    const reviewers = [...latest.entries()]
      .filter(([login, state]) => state === 'CHANGES_REQUESTED' && !alreadyPending.has(login.toLowerCase()))
      .map(([login]) => login);
    if (!reviewers.length) return [];

    await octokit.pulls.requestReviewers({ owner, repo: name, pull_number: prNumber, reviewers });
    return reviewers;
  } catch (err) {
    console.warn(`[github] re-request review on ${repo}#${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// --- WS5 --- Rebase a PR branch onto its base by merging the base branch into the head branch
// (creates a merge commit that updates the PR branch). Best-effort; reports conflicts instead of
// throwing so the caller can fall back to a follow-up job.
export async function rebasePullRequestBranch(
  repo: string,
  headBranch: string,
  baseBranch: string
): Promise<{ ok: boolean; conflict?: boolean }> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    await octokit.repos.merge({
      owner,
      repo: name,
      base: headBranch,
      head: baseBranch,
      commit_message: `Merge ${baseBranch} into ${headBranch} (Hermes auto-rebase after overlapping merge)`,
    });
    return { ok: true };
  } catch (err: any) {
    if (err?.status === 409) return { ok: false, conflict: true };
    console.warn(`[github] rebase ${repo} ${headBranch}<-${baseBranch} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

// --- WS5 --- Concatenate a PR's body and its issue comments into a single searchable blob for
// readiness gates (checklist / evidence). Best-effort — returns '' on any failure.
export async function collectPrBodyAndComments(repo: string, prNumber: number): Promise<string> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    const pr = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber }).then((r) => r.data);
    const parts: string[] = [String(pr.body ?? '')];
    for (let page = 1; page <= 5; page++) {
      const res = await octokit.issues.listComments({ owner, repo: name, issue_number: prNumber, per_page: 100, page });
      parts.push(...res.data.map((c) => String(c.body ?? '')));
      if (res.data.length < 100) break;
    }
    return parts.filter(Boolean).join('\n\n');
  } catch (err) {
    console.warn(`[github] collect PR body/comments for ${repo}#${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

export async function listRepositoryPaths(repo: string, ref: string): Promise<string[]> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  const res = await octokit.git.getTree({ owner, repo: name, tree_sha: ref, recursive: 'true' });
  return (res.data.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => entry.path!)
    .sort();
}

function compactText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function checkRunSignals(octokit: Octokit, repo: string, headSha: string): Promise<{ ciState: PrSnapshot['ciState']; signals: PrSignal[] }> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo: name,
    ref: headSha,
    per_page: 100,
  });
  const runs = res.data.check_runs ?? [];
  if (!runs.length) return { ciState: 'unknown', signals: [] };

  const failing = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(String(r.conclusion ?? '')));
  const pending = runs.some((r) => r.status !== 'completed');
  const signals: PrSignal[] = [];
  for (const run of failing.slice(0, 8)) {
    // A completed check run's annotations never change, so cache them by run id — this used to be up
    // to 8 REST calls per failing PR on every single reconcile tick.
    const annotationText = await annotationsCache(`${repo}:${run.id}`, async () => {
      const annotations = await octokit
        .request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
          owner,
          repo: name,
          check_run_id: run.id,
          per_page: 10,
        })
        .then((r) => r.data)
        .catch(() => []);
      return annotations
        .slice(0, 5)
        .map((a) => `  - ${a.path}:${a.start_line ?? '?'} ${compactText(a.message, 240)}`)
        .join('\n');
    });
    signals.push({
      id: `ci:${headSha}:check:${run.id}:${run.conclusion}`,
      kind: 'ci_failed',
      headSha,
      summary: `${run.name} concluded ${run.conclusion}`,
      details: annotationText || compactText(run.output?.summary || run.output?.text || run.html_url, 900),
      url: run.html_url ?? undefined,
      createdAt: new Date().toISOString(),
    });
  }

  return { ciState: failing.length ? 'failing' : pending ? 'pending' : 'passing', signals };
}

function workflowCheckHints(workflowId: string): string[] {
  const raw = String(workflowId || '').toLowerCase();
  const base = raw
    .split('/')
    .pop()!
    .replace(/\.(ya?ml)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const hints = new Set<string>([raw, base].filter(Boolean));
  if (raw === '212167110' || raw.includes('staging')) {
    hints.add('staging build');
    hints.add('build');
  }
  if (raw === '208630294' || raw.includes('deploy')) {
    hints.add('deploy to staging');
    hints.add('deploy');
  }
  return [...hints].filter(Boolean);
}

export async function latestWorkflowSignalForCommit(repo: string, workflowId: string, headSha: string, branch?: string): Promise<WorkflowRunSummary | null> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
      owner,
      repo: name,
      workflow_id: workflowId,
      branch,
      per_page: 50,
    });
    const run = ((res.data.workflow_runs ?? []) as any[]).find((candidate) => candidate.head_sha === headSha);
    if (run) {
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        headSha: run.head_sha,
        createdAt: run.created_at,
      };
    }
  } catch {
    // Some scoped GitHub App tokens can read checks but not resolve the workflow id.
  }

  const checkRes = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo: name,
    ref: headSha,
    per_page: 100,
  });
  const actionRuns = ((checkRes.data.check_runs ?? []) as any[]).filter((run) =>
    String(run.details_url ?? run.html_url ?? '').includes('/actions/runs/')
  );
  if (!actionRuns.length) return null;

  const hints = workflowCheckHints(workflowId);
  const matching = actionRuns.filter((run) => {
    const runName = String(run.name ?? '').toLowerCase();
    return hints.some((hint) => runName.includes(hint) || hint.includes(runName));
  });
  const candidates = matching.length ? matching : actionRuns.length === 1 ? actionRuns : [];
  if (!candidates.length) return null;
  const match = candidates.sort((a, b) => Date.parse(b.started_at ?? b.created_at ?? '') - Date.parse(a.started_at ?? a.created_at ?? ''))[0];
  return {
    id: match.id,
    name: match.name,
    status: match.status,
    conclusion: match.conclusion,
    htmlUrl: match.details_url ?? match.html_url,
    headSha,
    createdAt: match.started_at ?? match.created_at,
  };
}

async function commitContainsAncestor(octokit: Octokit, repo: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  if (!ancestorSha || !descendantSha) return false;
  if (ancestorSha === descendantSha) return true;
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo: name,
    basehead: `${ancestorSha}...${descendantSha}`,
  });
  return Number(res.data.behind_by ?? 0) === 0 && ['ahead', 'identical'].includes(String(res.data.status ?? ''));
}

export async function latestSuccessfulWorkflowSignalContainingCommit(
  repo: string,
  workflowId: string,
  ancestorSha: string,
  branch?: string
): Promise<WorkflowRunSummary | null> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner,
    repo: name,
    workflow_id: workflowId,
    branch,
    status: 'success',
    per_page: 50,
  });

  for (const run of (res.data.workflow_runs ?? []) as any[]) {
    const headSha = String(run.head_sha ?? '');
    if (!headSha || run.status !== 'completed' || run.conclusion !== 'success') continue;
    const contains = await commitContainsAncestor(octokit, repo, ancestorSha, headSha).catch(() => false);
    if (!contains) continue;
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
      headSha,
      createdAt: run.created_at,
    };
  }
  return null;
}

export function signalFromReviewThreadNode(thread: any): PrSignal | null {
  if (thread?.isResolved || thread?.isOutdated) return null;

  const comments = (thread?.comments?.nodes ?? []) as any[];
  const root = comments[0];
  const last = comments[comments.length - 1];
  if (!last?.id) return null;

  // An unresolved GitHub thread remains open until a reviewer resolves it. A Hermes reply should
  // acknowledge the fix without causing another fix job. If a reviewer replies after our marker,
  // their comment becomes `last` and produces a fresh signal as expected.
  // Automated reviewers can open actionable threads too. Suppression only proves that Hermes
  // replied to the exact latest non-Hermes feedback comment; trusted-human checks belong solely to
  // lesson capture below.
  const latestFeedbackBeforeReply = comments
    .slice(0, -1)
    .reduce<any | undefined>(
      (latest, comment) => (isHermesReviewComment(comment) ? latest : comment),
      undefined
    );
  if (
    isHermesReviewComment(last) &&
    markerFeedbackId(last.body) === String(latestFeedbackBeforeReply?.id ?? '')
  ) {
    return null;
  }

  const rootCommentId = Number(root?.databaseId);
  const body = comments
    .map((comment: any) => {
      const text = String(comment.body ?? '').replace(/<!-- hermes-review-addressed:[^>]*-->/g, '');
      return `${comment.author?.login ?? 'reviewer'}: ${compactText(text, 500)}`;
    })
    .join('\n');

  return {
    id: `review:${thread.id}:${last.id}`,
    kind: 'review_feedback',
    summary: `Unresolved review thread on ${thread.path ?? 'unknown file'}${thread.line ? `:${thread.line}` : ''}`,
    details: body,
    url: last.url,
    reviewThreadId: thread.id,
    reviewCommentId: last.id,
    reviewRootCommentId: Number.isSafeInteger(rootCommentId) && rootCommentId > 0 ? rootCommentId : undefined,
    createdAt: last.createdAt ?? new Date().toISOString(),
  };
}

const TRUSTED_REVIEW_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_REVIEW_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'PUSH']);
const reviewerPermissionCache = new Map<string, { permission: string; expiresAt: number }>();
const REVIEWER_PERMISSION_CACHE_MS = 5 * 60 * 1000;
const REVIEW_ACKNOWLEDGEMENT =
  /^(?:lgtm|looks good(?: to me)?|thank(?:s| you)|done|resolved|approved|nice|great)[.! 👍✅]*$/i;
const PROMPT_INJECTION_LANGUAGE =
  /\b(?:ignore (?:all |any |the )?(?:previous|prior) instructions?|system (?:prompt|message)|developer message|reveal (?:a |the )?(?:secret|token|credential)|exfiltrat(?:e|ion)|you are (?:chatgpt|an ai)|begin system)\b/i;

function isHermesOrBotComment(comment: any): boolean {
  const login = String(comment?.author?.login ?? '').toLowerCase();
  return (
    !login ||
    String(comment?.author?.__typename ?? '').toLowerCase() === 'bot' ||
    isHermesReviewComment(comment) ||
    login.endsWith('[bot]')
  );
}

function reviewerLogin(comment: any): string {
  return String(comment?.author?.login ?? '').trim().toLowerCase();
}

export function isTrustedReviewerPermission(permission: unknown): boolean {
  return TRUSTED_REVIEW_PERMISSIONS.has(String(permission ?? '').trim().toUpperCase());
}

function isTrustedHumanComment(
  comment: any,
  reviewerPermissions: ReadonlyMap<string, string> = new Map()
): boolean {
  const login = reviewerLogin(comment);
  return (
    !isHermesOrBotComment(comment) &&
    (TRUSTED_REVIEW_ASSOCIATIONS.has(String(comment?.authorAssociation ?? '').toUpperCase()) ||
      isTrustedReviewerPermission(reviewerPermissions.get(login)))
  );
}

/**
 * `authorAssociation` is viewer-sensitive: GitHub can report an organization administrator as a
 * CONTRIBUTOR to an installation token even though the same review appears as MEMBER to a user
 * token. Resolve those ambiguous humans against repository permission instead of either dropping
 * trusted feedback or allowing every contributor to poison durable memory.
 */
async function resolveReviewerPermissions(
  octokit: Octokit,
  repo: string,
  activities: any[]
): Promise<Map<string, string>> {
  const { owner, name } = splitRepo(repo);
  const logins = [
    ...new Set(
      activities
        .filter(
          (activity) =>
            !isHermesOrBotComment(activity) &&
            !TRUSTED_REVIEW_ASSOCIATIONS.has(
              String(activity?.authorAssociation ?? '').toUpperCase()
            )
        )
        .map(reviewerLogin)
        .filter(Boolean)
    ),
  ];
  const permissions = new Map<string, string>();
  await Promise.all(
    logins.map(async (login) => {
      const key = `${repo.toLowerCase()}\0${login}`;
      const cached = reviewerPermissionCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        permissions.set(login, cached.permission);
        return;
      }
      try {
        const result = await octokit.repos.getCollaboratorPermissionLevel({
          owner,
          repo: name,
          username: login,
        });
        const permission = String(result.data.permission ?? '').toUpperCase();
        reviewerPermissionCache.set(key, {
          permission,
          expiresAt: Date.now() + REVIEWER_PERMISSION_CACHE_MS,
        });
        permissions.set(login, permission);
      } catch (err) {
        // A non-collaborator is expected to return 404 and remains untrusted. Other failures must
        // retry the durable capture instead of being mistaken for a valid zero-lesson result.
        if ((err as { status?: number }).status !== 404) throw err;
        reviewerPermissionCache.set(key, {
          permission: 'NONE',
          expiresAt: Date.now() + REVIEWER_PERMISSION_CACHE_MS,
        });
        permissions.set(login, 'NONE');
      }
    })
  );
  return permissions;
}

function cleanReviewFeedback(body: unknown, limit = 1200): string {
  return compactText(
    String(body ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' '),
    limit
  );
}

function isLearnableFeedback(body: string): boolean {
  return body.length >= 12 && !REVIEW_ACKNOWLEDGEMENT.test(body) && !PROMPT_INJECTION_LANGUAGE.test(body);
}

function markerFixCommit(body: unknown): string | undefined {
  const match = String(body ?? '').match(/\bcommit\s+`?([a-f0-9]{7,40})`?/i);
  return match?.[1]?.toLowerCase();
}

function markerFeedbackId(body: unknown): string | undefined {
  const match = String(body ?? '').match(/<!--\s*hermes-review-addressed:([A-Za-z0-9_:-]+)\s*-->/);
  return match?.[1];
}

/**
 * Learning is a snapshot of feedback accepted by a particular merge. A later reconcile may see
 * comments, edits, or approvals posted after that merge, so conservatively exclude any review
 * object whose creation/submission or latest edit is outside the immutable merge boundary.
 */
function reviewActivityAtOrBefore(activity: any, acceptedBefore?: string | null): boolean {
  if (!acceptedBefore) return true;
  const cutoffMs = Date.parse(acceptedBefore);
  if (!Number.isFinite(cutoffMs)) return false;

  const timestamps = [activity?.createdAt, activity?.submittedAt, activity?.updatedAt].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  return (
    timestamps.length > 0 &&
    timestamps.every((value) => {
      const activityMs = Date.parse(value);
      return Number.isFinite(activityMs) && activityMs <= cutoffMs;
    })
  );
}

/**
 * Convert a review thread into a candidate lesson. This is deliberately stricter than signal
 * detection: the author must be trusted, the content must be substantive, and GitHub/Hermes must
 * provide evidence that the feedback was addressed. The caller still waits for PR merge before
 * persisting it.
 */
export function lessonFromReviewThreadNode(
  thread: any,
  acceptedBefore?: string | null,
  resolutionEvidence?: Pick<
    ReviewThreadResolutionEvidence,
    'resolutionObservedAt' | 'resolvedBy'
  >,
  reviewerPermissions: ReadonlyMap<string, string> = new Map()
): ReviewLessonCandidate | null {
  const comments = ((thread?.comments?.nodes ?? []) as any[]).filter((comment) =>
    reviewActivityAtOrBefore(comment, acceptedBefore)
  );
  if (!thread?.id || !comments.length) return null;

  let lastNonBotHumanIndex = -1;
  let lastMarkerIndex = -1;
  comments.forEach((comment, index) => {
    if (!isHermesOrBotComment(comment)) {
      lastNonBotHumanIndex = index;
      return;
    }
    if (
      isHermesReviewComment(comment) &&
      lastNonBotHumanIndex >= 0 &&
      isTrustedHumanComment(comments[lastNonBotHumanIndex], reviewerPermissions) &&
      markerFeedbackId(comment.body) === String(comments[lastNonBotHumanIndex]?.id ?? '')
    ) {
      lastMarkerIndex = index;
    }
  });
  const hermesRepliedAfterFeedback = lastMarkerIndex > lastNonBotHumanIndex && lastNonBotHumanIndex >= 0;
  const resolvedBeforeAcceptance =
    Boolean(thread.isResolved) &&
    (!acceptedBefore ||
      Boolean(
        resolutionEvidence?.resolutionObservedAt &&
          reviewActivityAtOrBefore(
            { updatedAt: resolutionEvidence.resolutionObservedAt },
            acceptedBefore
          )
      ));
  if (!resolvedBeforeAcceptance && !hermesRepliedAfterFeedback) return null;

  const evidenceComments = resolvedBeforeAcceptance
    ? comments.filter((comment) =>
        reviewActivityAtOrBefore(comment, resolutionEvidence?.resolutionObservedAt)
      )
    : [comments[lastNonBotHumanIndex]];
  const feedbackComments = evidenceComments
    .filter((comment) => isTrustedHumanComment(comment, reviewerPermissions))
    .map((comment) => ({ comment, text: cleanReviewFeedback(comment.body, 700) }))
    .filter(({ text }) => isLearnableFeedback(text))
    .slice(-3);
  if (!feedbackComments.length) return null;

  const feedback = feedbackComments
    .map(({ comment, text }) => `${comment.author.login}: ${text}`)
    .join('\n')
    .slice(0, 1600);
  const latest = feedbackComments[feedbackComments.length - 1].comment;
  const markerComment = lastMarkerIndex >= 0 ? comments[lastMarkerIndex] : undefined;
  const reviewers = [...new Set(feedbackComments.map(({ comment }) => String(comment.author.login)))];
  const associations = [
    ...new Set(feedbackComments.map(({ comment }) => String(comment.authorAssociation).toUpperCase())),
  ];
  const rawLine = thread.line ?? thread.originalLine;
  const line = rawLine == null ? undefined : Number(rawLine);

  return {
    sourceId: `thread:${thread.id}`,
    feedbackCommentId: String(latest.id ?? ''),
    path: thread.path ? String(thread.path) : undefined,
    line: line !== undefined && Number.isSafeInteger(line) && line > 0 ? line : undefined,
    feedback,
    reviewerLogins: reviewers,
    reviewerAssociations: associations,
    reviewerPermissions: reviewers
      .map((login) => reviewerPermissions.get(login.toLowerCase()))
      .filter((permission): permission is string => Boolean(permission)),
    sourceUrl: String(latest.url ?? ''),
    feedbackCreatedAt: String(latest.createdAt ?? new Date().toISOString()),
    evidence: resolvedBeforeAcceptance ? 'thread_resolved' : 'hermes_replied',
    resolvedBy: resolvedBeforeAcceptance
      ? resolutionEvidence?.resolvedBy ??
        (thread.resolvedBy?.login ? String(thread.resolvedBy.login) : undefined)
      : undefined,
    fixCommitSha: markerFixCommit(markerComment?.body),
  };
}

/**
 * A top-level CHANGES_REQUESTED review becomes learnable only when the same trusted reviewer later
 * approves. Merge gating happens separately, so an admin-merged change request is never promoted
 * merely because the PR closed.
 */
export function lessonsFromReviewNodes(
  reviews: any[],
  fallbackUrl = '',
  acceptedBefore?: string | null,
  reviewerPermissions: ReadonlyMap<string, string> = new Map()
): ReviewLessonCandidate[] {
  const acceptedReviews = reviews.filter((review) =>
    reviewActivityAtOrBefore(review, acceptedBefore)
  );
  return acceptedReviews.flatMap((review, index) => {
    if (
      String(review?.state ?? '').toUpperCase() !== 'CHANGES_REQUESTED' ||
      !isTrustedHumanComment(review, reviewerPermissions)
    ) {
      return [];
    }
    const body = cleanReviewFeedback(review.body);
    if (!isLearnableFeedback(body)) return [];

    const login = String(review.author.login);
    const submittedAt = String(review.submittedAt ?? review.updatedAt ?? '');
    const submittedMs = Date.parse(submittedAt);
    const laterApproval = acceptedReviews.some((candidate) => {
      if (
        String(candidate?.state ?? '').toUpperCase() !== 'APPROVED' ||
        String(candidate?.author?.login ?? '').toLowerCase() !== login.toLowerCase() ||
        !isTrustedHumanComment(candidate, reviewerPermissions)
      ) {
        return false;
      }
      const approvedMs = Date.parse(String(candidate.submittedAt ?? candidate.updatedAt ?? ''));
      return Number.isFinite(submittedMs) && Number.isFinite(approvedMs) && approvedMs > submittedMs;
    });
    if (!laterApproval) return [];

    const reviewId = String(review.id ?? review.databaseId ?? `${login}:${submittedAt}:${index}`);
    return [
      {
        sourceId: `review:${reviewId}`,
        feedbackCommentId: reviewId,
        feedback: `${login}: ${body}`,
        reviewerLogins: [login],
        reviewerAssociations: [String(review.authorAssociation).toUpperCase()],
        reviewerPermissions: reviewerPermissions.has(login.toLowerCase())
          ? [String(reviewerPermissions.get(login.toLowerCase()))]
          : undefined,
        sourceUrl: String(review.url ?? fallbackUrl),
        feedbackCreatedAt: submittedAt || new Date().toISOString(),
        evidence: 'reviewer_approved' as const,
      },
    ];
  });
}

/**
 * Marker-based evidence is valid only while its claimed fix commit remains in the accepted PR
 * history. Human resolution/approval evidence does not depend on a Hermes-authored commit.
 */
export async function filterReviewLessonsForAcceptedCommits(
  lessons: ReviewLessonCandidate[],
  isAcceptedCommit: (sha: string) => Promise<boolean>
): Promise<ReviewLessonCandidate[]> {
  const decisions = new Map<string, Promise<boolean>>();
  const checked = await Promise.all(
    lessons.map(async (lesson) => {
      if (lesson.evidence !== 'hermes_replied') return lesson;
      const sha = String(lesson.fixCommitSha ?? '').toLowerCase();
      if (!sha) return null;
      let decision = decisions.get(sha);
      if (!decision) {
        decision = isAcceptedCommit(sha).catch(() => false);
        decisions.set(sha, decision);
      }
      return (await decision) ? lesson : null;
    })
  );
  return checked.filter(
    (lesson: ReviewLessonCandidate | null): lesson is ReviewLessonCandidate => Boolean(lesson)
  );
}

interface ReviewSnapshot {
  signals: PrSignal[];
  lessons: ReviewLessonCandidate[];
}

async function collectReviewSnapshot(
  token: string,
  octokit: Octokit,
  repo: string,
  prNumber: number,
  mergedAt?: string | null
): Promise<ReviewSnapshot> {
  const { owner, name } = splitRepo(repo);
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewDecision
          reviews(last: 50) {
            nodes {
              id
              databaseId
              state
              body
              url
              submittedAt
              updatedAt
              authorAssociation
              author { login __typename }
            }
          }
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              originalLine
              resolvedBy { login }
              comments(first: 100) {
                nodes {
                  id
                  databaseId
                  body
                  url
                  createdAt
                  updatedAt
                  authorAssociation
                  author { login __typename }
                }
              }
            }
          }
        }
      }
    }`;
  const threads: any[] = [];
  let reviews: any[] = [];
  let reviewDecision = '';
  let after: string | undefined;

  for (let page = 0; page < 5; page++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, number: prNumber, after } }),
    });
    if (!res.ok) {
      const error = new Error(
        `GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`
      ) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    const data = (await res.json()) as any;
    if (data.errors?.length) {
      const first = data.errors[0] ?? {};
      const error = new Error(
        `GitHub GraphQL: ${String(first.message ?? 'unknown error').slice(0, 200)}`
      ) as Error & { code?: string };
      error.code = String(first.type ?? first.extensions?.code ?? '');
      throw error;
    }
    const pr = data.data?.repository?.pullRequest;
    if (!pr) break;
    if (!page) {
      reviews = pr.reviews?.nodes ?? [];
      reviewDecision = String(pr.reviewDecision ?? '').toUpperCase();
    }
    const connection = pr.reviewThreads;
    threads.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    after = String(connection.pageInfo.endCursor);
  }

  const threadSignals = threads
    .map(signalFromReviewThreadNode)
    .filter((signal: PrSignal | null): signal is PrSignal => Boolean(signal));
  const latestDecisiveReviewByAuthor = new Map<string, any>();
  for (const review of reviews) {
    const state = String(review?.state ?? '').toUpperCase();
    const author = String(review?.author?.login ?? '').toLowerCase();
    if (!author || state === 'COMMENTED' || state === 'PENDING') continue;
    const current = latestDecisiveReviewByAuthor.get(author);
    const candidateAt = Date.parse(String(review.submittedAt ?? review.updatedAt ?? ''));
    const currentAt = Date.parse(String(current?.submittedAt ?? current?.updatedAt ?? ''));
    if (!current || !Number.isFinite(currentAt) || candidateAt >= currentAt) {
      latestDecisiveReviewByAuthor.set(author, review);
    }
  }
  const decisionSignals =
    reviewDecision === 'CHANGES_REQUESTED'
      ? [...latestDecisiveReviewByAuthor.values()]
          .filter(
            (review) =>
              String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED' &&
              Boolean(String(review?.body ?? '').trim())
          )
          .map((review) => {
            const createdAt = review.submittedAt ?? review.updatedAt ?? new Date().toISOString();
            const reviewId = review.databaseId ?? review.id ?? createdAt;
            return {
              id: `review-state:${reviewId}:${createdAt}`,
              kind: 'review_feedback',
              summary: `Review requested changes by ${review.author?.login ?? 'reviewer'}`,
              details: compactText(review.body, 1200),
              url: review.url,
              createdAt,
            } as PrSignal;
          })
      : [];
  const fallbackUrl = `https://github.com/${repo}/pull/${prNumber}`;
  // Open-PR reconciliation only needs actionable signals. Defer permission reads until the
  // immutable merge boundary exists so this trust check adds no latency to normal ticket/PR work.
  const reviewerPermissions = mergedAt
    ? await resolveReviewerPermissions(octokit, repo, [
        ...reviews,
        ...threads.flatMap((thread) => thread?.comments?.nodes ?? []),
      ])
    : new Map<string, string>();
  const resolvedThreadIds = threads
    .filter((thread) => Boolean(thread?.isResolved))
    .map((thread) => String(thread.id ?? ''))
    .filter(Boolean);
  const resolutionEvidence =
    mergedAt && resolvedThreadIds.length
      ? await listReviewThreadResolutionEvidence(
          repo,
          prNumber,
          resolvedThreadIds
        ).catch(() => [])
      : [];
  const latestResolutionByThread = new Map<string, ReviewThreadResolutionEvidence>();
  for (const evidence of resolutionEvidence) {
    const current = latestResolutionByThread.get(evidence.threadId);
    if (
      !current ||
      Date.parse(evidence.resolutionObservedAt) >
        Date.parse(current.resolutionObservedAt)
    ) {
      latestResolutionByThread.set(evidence.threadId, evidence);
    }
  }
  const lessons = [
    ...threads
      .map((thread) =>
        lessonFromReviewThreadNode(
          thread,
          mergedAt,
          latestResolutionByThread.get(String(thread.id ?? '')),
          reviewerPermissions
        )
      )
      .filter((lesson: ReviewLessonCandidate | null): lesson is ReviewLessonCandidate => Boolean(lesson)),
    ...lessonsFromReviewNodes(reviews, fallbackUrl, mergedAt, reviewerPermissions),
  ];
  return { signals: [...threadSignals, ...decisionSignals], lessons };
}

function mergeConflictSignal(pr: any): PrSignal | null {
  const mergeableState = String(pr.mergeable_state ?? 'unknown');
  const mergeable = pr.mergeable as boolean | null | undefined;
  if (mergeable !== false || mergeableState !== 'dirty') return null;

  const headSha = String(pr.head?.sha ?? '');
  const baseSha = String(pr.base?.sha ?? '');
  const baseRef = String(pr.base?.ref ?? 'base');
  const headRef = String(pr.head?.ref ?? 'PR branch');

  return {
    id: `merge-conflict:${headSha}:${baseSha}:${mergeableState}`,
    kind: 'merge_conflict',
    headSha,
    summary: `PR branch has merge conflicts with ${baseRef}`,
    details: [
      `GitHub reports mergeable=false and mergeable_state=dirty for ${headRef}.`,
      `Reconcile ${headRef} with ${baseRef}${baseSha ? ` (${baseSha.slice(0, 12)})` : ''}, resolve conflicts, and push the PR branch.`,
    ].join(' '),
    url: pr.html_url,
    createdAt: new Date().toISOString(),
  };
}

export async function collectPrSnapshot(watch: PrWatch, extraSignals: PrSignal[] = []): Promise<PrSnapshot> {
  const { token, octokit } = await getInstallationAuth(watch.repo);
  const { owner, name } = splitRepo(watch.repo);
  const pr = await octokit.pulls.get({ owner, repo: name, pull_number: watch.prNumber }).then((r) => r.data);
  const headSha = pr.head.sha;
  const [checks, reviews] = await Promise.all([
    checkRunSignals(octokit, watch.repo, headSha),
    collectReviewSnapshot(token, octokit, watch.repo, watch.prNumber, pr.merged_at),
  ]);
  const mergeSignal = mergeConflictSignal(pr);
  const state: PrSnapshot['state'] = pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';
  const acceptedReviewLessons =
    state === 'MERGED'
      ? await filterReviewLessonsForAcceptedCommits(reviews.lessons, async (fixCommitSha) => {
          // `headSha` is the exact accepted source history even when GitHub squash/rebase merging
          // means the original PR commits are not ancestors of `merge_commit_sha`.
          const acceptedDescendants = [
            headSha,
            pr.merge_commit_sha ? String(pr.merge_commit_sha) : '',
          ].filter((sha, index, values) => Boolean(sha) && values.indexOf(sha) === index);
          for (const descendantSha of acceptedDescendants) {
            if (
              await commitContainsAncestor(
                octokit,
                watch.repo,
                fixCommitSha,
                descendantSha
              ).catch(() => false)
            ) {
              return true;
            }
          }
          return false;
        })
      : reviews.lessons;
  const labels = (pr.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((label): label is string => Boolean(label));
  return {
    repo: watch.repo,
    prNumber: watch.prNumber,
    prUrl: pr.html_url,
    headBranch: pr.head.ref,
    headSha,
    state,
    ciState: checks.ciState,
    mergeable: pr.mergeable,
    mergeableState: (pr as any).mergeable_state,
    baseBranch: pr.base.ref,
    baseSha: pr.base.sha,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    signals: [...checks.signals, ...reviews.signals, ...(mergeSignal ? [mergeSignal] : []), ...extraSignals],
    reviewLessons: acceptedReviewLessons,
    labels,
  };
}

export function reviewThreadResolutionFromWebhook(
  body: Record<string, any>,
  eventName: string,
  receivedAt: string
): Pick<
  ReviewThreadResolutionEvidence,
  'threadId' | 'resolutionObservedAt' | 'resolvedBy'
> | null {
  if (eventName !== 'pull_request_review_thread' || String(body.action ?? '') !== 'resolved') {
    return null;
  }
  const threadId = String(body.thread?.node_id ?? body.thread?.nodeId ?? '');
  if (!threadId || !Number.isFinite(Date.parse(receivedAt))) return null;
  const resolvedBy = String(body.sender?.login ?? '').trim();
  return {
    threadId,
    resolutionObservedAt: receivedAt,
    resolvedBy: resolvedBy || undefined,
  };
}

export function signalFromReviewWebhook(body: Record<string, any>): PrSignal | null {
  const review = body.review;
  if (!review || String(review.state).toLowerCase() !== 'changes_requested') return null;
  const text = String(review.body ?? '').trim();
  // An empty review body means the actionable content lives in inline threads. Starting from this
  // generic event races those thread webhooks and spends a repair attempt without giving the worker
  // the actual feedback.
  if (!text) return null;
  return {
    id: `review-state:${review.id}:${review.submitted_at ?? review.updated_at ?? Date.now()}`,
    kind: 'review_feedback',
    summary: `Review requested changes by ${review.user?.login ?? 'reviewer'}`,
    details: compactText(text, 1200),
    url: review.html_url,
    createdAt: review.submitted_at ?? new Date().toISOString(),
  };
}

export function signalFromPrCommentWebhook(body: Record<string, any>): PrSignal | null {
  const comment = body.comment;
  if (!comment?.body) return null;
  const authorLogin = String(comment.user?.login ?? '');
  // Issue-comment webhooks include comments created by the GitHub App itself. Several normal
  // Hermes notices contain the word "Hermes" (for example overlap warnings), so without this
  // guard the bot treats its own status message as human review feedback and queues a repair job.
  if (/(^|\/)donatemate-hermes(?:\[bot\])?$/i.test(authorLogin)) return null;
  const text = String(comment.body);
  if (!/(^|\s)(@?hermes|\/hermes|please fix|can you address)/i.test(text)) return null;
  return {
    id: `pr-comment:${comment.id}:${comment.updated_at ?? comment.created_at}`,
    kind: 'review_feedback',
    summary: `Top-level PR comment by ${authorLogin || 'reviewer'}`,
    details: compactText(text, 1500),
    url: comment.html_url,
    createdAt: comment.created_at ?? new Date().toISOString(),
  };
}
