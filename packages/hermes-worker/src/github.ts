/**
 * GitHub App integration. Mints a short-lived installation token per job (never stored on
 * disk), clones the target repo cleanly, pushes the work branch, and opens a PR.
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { getSecretJson } from './secrets.js';
import type { ReviewReplyTarget } from './jobs.js';

const exec = promisify(execFile);
const SECRET_GITHUB_APP = process.env.SECRET_GITHUB_APP!;

export interface GitHubAuth {
  token: string;
  octokit: Octokit;
}

export interface PullRequestInfo {
  number: number;
  url: string;
}

/**
 * Permissions on each short-lived worker token. Keep this narrower than the app installation, but
 * include `workflows: write`: infrastructure tickets legitimately edit `.github/workflows/*`, and
 * GitHub rejects those pushes even when `contents: write` is present if this scope is omitted.
 */
export const WORKER_INSTALLATION_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'write',
  metadata: 'read',
  workflows: 'write',
} as const;

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo full name: ${repo}`);
  return { owner, name };
}

/**
 * Create an installation token + Octokit client, scoped down to ONLY the permissions this
 * worker needs and restricted to the single target repo. Even if the GitHub App is configured
 * with broader permissions, the per-job token is least-privilege (defense in depth). Token
 * lifetime ~1h.
 */
export async function getInstallationAuth(repoFullName: string): Promise<GitHubAuth> {
  const { appId, installationId, privateKey } = await getSecretJson(SECRET_GITHUB_APP);
  if (!appId || !installationId || !privateKey) {
    throw new Error('GitHub App credentials not configured in Secrets Manager');
  }
  const repoName = repoFullName.split('/')[1];
  const auth = createAppAuth({ appId, installationId, privateKey });
  const { token } = await auth({
    type: 'installation',
    repositoryNames: repoName ? [repoName] : undefined,
    permissions: WORKER_INSTALLATION_PERMISSIONS,
  });
  return { token, octokit: new Octokit({ auth: token }) };
}

/**
 * Clone `owner/repo` at `baseBranch` into `dir` using the install token.
 *
 * WS1: uses a blobless (`--filter=blob:none`) clone rather than `--depth 1`. A shallow clone has
 * no commit history, which breaks turborepo's `--changedSince`/`--filter=[base...]` change
 * detection and any `git diff` against the merge base — the worker (and the pre-commit gate)
 * need history to scope lint/test to changed packages. Blobless keeps the full commit graph while
 * fetching file blobs lazily on demand, so it stays fast without sacrificing history.
 *
 * Retries a few times: a freshly-minted scoped installation token can briefly 404 ("Repository
 * not found") on clone due to GitHub token-propagation lag.
 */
export async function cloneRepo(token: string, repo: string, baseBranch: string, dir: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await exec('git', ['clone', '--filter=blob:none', '--no-tags', '--branch', baseBranch, url, dir], {
        maxBuffer: 16 * 1024 * 1024,
      });
      await exec('git', ['-C', dir, 'config', 'user.name', 'DonateMate Hermes']);
      await exec('git', ['-C', dir, 'config', 'user.email', 'hermes@donate-mate.com']);
      // Disable repo git hooks (husky) — the harness owns validation via the WS2 gate + post-open CI.
      // Leaving hooks live lets a repo pre-commit/pre-push hook block the harness's controlled
      // commit/push (observed failing BE jobs after WS1 started installing husky).
      await exec('git', ['-C', dir, 'config', 'core.hooksPath', '/dev/null']);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the transient propagation/network 404s, not genuine auth/branch errors.
      const transient = /not found|could not resolve|timed out|connection|tls|ssl/i.test(msg);
      if (!transient || attempt === 4) break;
      console.warn(`[clone] attempt ${attempt} failed (${msg.split('\n')[0]}); retrying…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastErr;
}

function sanitizeGitAuthError(err: any): any {
  const redact = (value: unknown) =>
    typeof value === 'string' ? value.replace(/x-access-token:[^@]+@/g, 'x-access-token:<redacted>@') : value;
  if (err && typeof err === 'object') {
    err.message = redact(err.message);
    err.stdout = redact(err.stdout);
    err.stderr = redact(err.stderr);
  }
  return err;
}

function gitCommandErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const commandError = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [commandError.message, commandError.stdout, commandError.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

/** Git's stable rejection variants when another writer advanced the remote branch. */
export function isNonFastForwardPushError(err: unknown): boolean {
  return /non-fast-forward|\[rejected\].*fetch first|tip of your current branch is behind|remote contains work that you do not have locally/i.test(
    gitCommandErrorText(err)
  );
}

/**
 * A PR branch changed too many times, or could not be merged safely, while a follow-up was running.
 * The worker treats this as transient infrastructure concurrency: it retries the same durable job
 * from the newest branch head instead of failing the job or moving its Jira issue back to To Do.
 */
export class ConcurrentBranchUpdateError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 15) {
    super(message);
    this.name = 'ConcurrentBranchUpdateError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RemoteBranchReconciliation {
  localSha: string;
  remoteSha: string;
  output: string;
}

/**
 * Fetch and merge the exact current PR-branch head into Hermes' completed local change.
 *
 * The resulting push remains a normal fast-forward; this deliberately never force-pushes. If the
 * two changes conflict, abort the merge so the local commit remains intact and ask the durable job
 * loop to restart from the current remote head.
 */
export async function reconcileRemoteBranchUpdate(
  dir: string,
  branch: string
): Promise<RemoteBranchReconciliation> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await exec(
    'git',
    ['-C', dir, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteRef}`],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const [{ stdout: localShaOut }, { stdout: remoteShaOut }] = await Promise.all([
    exec('git', ['-C', dir, 'rev-parse', 'HEAD']),
    exec('git', ['-C', dir, 'rev-parse', remoteRef]),
  ]);
  const localSha = localShaOut.trim();
  const remoteSha = remoteShaOut.trim();

  try {
    const { stdout, stderr } = await exec('git', ['-C', dir, 'merge', '--no-edit', remoteRef], {
      maxBuffer: 4 * 1024 * 1024,
    });
    await assertNoUnmergedFiles(dir);
    await assertNoConflictMarkers(dir);
    return { localSha, remoteSha, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const conflicts = await listUnmergedFiles(dir).catch(() => []);
    if (conflicts.length || /\bCONFLICT \(|Automatic merge failed|fix conflicts/i.test(gitCommandErrorText(err))) {
      await exec('git', ['-C', dir, 'merge', '--abort']).catch(() => {});
      throw new ConcurrentBranchUpdateError(
        `PR branch ${branch} advanced from ${localSha.slice(0, 7)} to ${remoteSha.slice(0, 7)} while Hermes was working, and automatic reconciliation conflicted${
          conflicts.length ? ` in ${conflicts.slice(0, 20).join(', ')}` : ''
        }. Retrying the same job from the latest remote head.`
      );
    }
    throw err;
  }
}

async function repoFromOrigin(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  const origin = stdout.trim();
  const match =
    origin.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/) ??
    origin.match(/github\.com\/([^/\s]+\/[^@\s/]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error(`Unable to parse GitHub repo from origin URL`);
  return match[1].replace(/\.git$/, '');
}

async function refreshOriginToken(dir: string): Promise<string> {
  const repo = await repoFromOrigin(dir);
  const { token } = await getInstallationAuth(repo);
  await exec('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repo}.git`]);
  return repo;
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  await exec('git', ['-C', dir, 'checkout', '-b', branch]);
}

/** SHA of the current HEAD (captured at branch creation as the pre-agent baseline). */
export async function getHeadSha(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

export interface MergeConflictPreparation {
  status: 'already_up_to_date' | 'merged_cleanly' | 'conflicted';
  /** Current base-branch head. Validation compares the resolved PR tree to this, not the old PR head. */
  baseSha: string;
  output: string;
  conflicts: string[];
}

async function listUnmergedFiles(dir: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', dir, 'diff', '--name-only', '--diff-filter=U']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertNoConflictMarkers(dir: string): Promise<void> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'grep', '-n', '-E', '^(<<<<<<<|>>>>>>>)']);
    if (stdout.trim()) {
      throw new Error(`unresolved conflict markers remain:\n${stdout.slice(0, 2000)}`);
    }
  } catch (err: any) {
    if (err?.code === 1) return;
    throw err;
  }
}

async function assertNoUnmergedFiles(dir: string): Promise<void> {
  const unmerged = await listUnmergedFiles(dir);
  if (unmerged.length) {
    throw new Error(`unresolved merge conflicts remain:\n${unmerged.map((file) => `- ${file}`).join('\n')}`);
  }
}

async function isShallowRepository(dir: string): Promise<boolean> {
  const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--is-shallow-repository']);
  return stdout.trim() === 'true';
}

async function ensureMergeHistoryAvailable(dir: string): Promise<void> {
  if (!(await isShallowRepository(dir))) return;
  await exec('git', ['-C', dir, 'fetch', '--unshallow', '--no-tags', 'origin'], {
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function prepareMergeConflictResolution(dir: string, baseBranch: string): Promise<MergeConflictPreparation> {
  const remoteBaseRef = `refs/remotes/origin/${baseBranch}`;
  await ensureMergeHistoryAvailable(dir);
  await exec('git', ['-C', dir, 'fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}:${remoteBaseRef}`], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const { stdout: baseShaOut } = await exec('git', ['-C', dir, 'rev-parse', remoteBaseRef]);
  const baseSha = baseShaOut.trim();
  try {
    const { stdout, stderr } = await exec('git', ['-C', dir, 'merge', '--no-edit', remoteBaseRef], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`.trim();
    return {
      status: /already up to date/i.test(output) ? 'already_up_to_date' : 'merged_cleanly',
      baseSha,
      output,
      conflicts: [],
    };
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').slice(0, 4000);
    const conflicts = await listUnmergedFiles(dir);
    if (conflicts.length || /\bCONFLICT \(|Automatic merge failed|fix conflicts/i.test(output)) {
      return { status: 'conflicted', baseSha, output, conflicts };
    }
    throw err;
  }
}

/**
 * True if the agent produced any work: an uncommitted working-tree change OR a new commit ahead
 * of the baseline (some agents commit on their own despite being told not to).
 */
export async function hasChanges(dir: string, baseSha?: string): Promise<boolean> {
  const { stdout } = await exec('git', ['-C', dir, 'status', '--porcelain']);
  if (stdout.trim().length > 0) return true;
  if (baseSha) {
    const head = await getHeadSha(dir);
    if (head !== baseSha) return true;
  }
  return false;
}

/** Stage + commit any working-tree changes (no-op if the agent already committed) and push. */
export async function commitAndPush(dir: string, branch: string, message: string): Promise<void> {
  await exec('git', ['-C', dir, 'add', '-A']);
  await assertNoUnmergedFiles(dir);
  await assertNoConflictMarkers(dir);
  // Commit only if something is staged — otherwise `git commit` errors with "nothing to commit".
  const staged = await exec('git', ['-C', dir, 'diff', '--cached', '--quiet']).then(
    () => false,
    () => true
  );
  if (staged) await exec('git', ['-C', dir, 'commit', '-m', message]);

  // Follow-up jobs share their branch with GitHub's `auto-update` label workflow. That workflow can
  // merge main after this job clones but before it pushes. Reconcile bounded remote advances with a
  // normal merge + fast-forward push; never blind-force and never discard either writer's changes.
  let repo = await refreshOriginToken(dir);
  let transientFailures = 0;
  let branchReconciliations = 0;
  try {
    for (;;) {
      try {
        await exec('git', ['-C', dir, 'push', 'origin', branch]);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isNonFastForwardPushError(err)) {
          if (branchReconciliations >= 3) {
            throw new ConcurrentBranchUpdateError(
              `PR branch ${branch} kept advancing while Hermes was pushing (${branchReconciliations} automatic reconciliations attempted). Retrying the same job from the latest remote head.`
            );
          }
          branchReconciliations += 1;
          console.warn(
            `[push] remote branch ${branch} advanced; reconciling ${branchReconciliations}/3 before retrying`
          );
          await reconcileRemoteBranchUpdate(dir, branch);
          continue;
        }

        const transient = /not found|could not resolve|timed out|connection|tls|ssl|remote end hung up|rpc failed/i.test(msg);
        transientFailures += 1;
        if (!transient || transientFailures >= 4) throw sanitizeGitAuthError(err);
        console.warn(`[push] transient attempt ${transientFailures} failed (${msg.split('\n')[0]}); retrying…`);
        await new Promise((r) => setTimeout(r, 1500 * transientFailures));
        repo = await refreshOriginToken(dir); // fresh token for the retry
      }
    }
  } finally {
    await exec('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`]).catch(() => {});
  }
}

/** Diff of the working tree (staged + unstaged) against a baseline SHA — the agent's full change. */
export async function getDiff(dir: string, baseSha: string, maxChars = 200_000): Promise<string> {
  await exec('git', ['-C', dir, 'add', '-A']);
  const { stdout } = await exec('git', ['-C', dir, 'diff', '--cached', baseSha], { maxBuffer: 32 * 1024 * 1024 });
  await exec('git', ['-C', dir, 'reset', '--quiet']).catch(() => {});
  return stdout.length > maxChars ? `${stdout.slice(0, maxChars)}\n… [diff truncated]` : stdout;
}

/**
 * Commit the working tree locally WITHOUT pushing (WS4 needs a clean tree so the review session's
 * stray edits can be discarded without losing the real change). Returns true if a commit was made.
 */
export async function commitLocal(dir: string, message: string): Promise<boolean> {
  await exec('git', ['-C', dir, 'add', '-A']);
  await assertNoUnmergedFiles(dir);
  await assertNoConflictMarkers(dir);
  const staged = await exec('git', ['-C', dir, 'diff', '--cached', '--quiet']).then(
    () => false,
    () => true
  );
  if (staged) await exec('git', ['-C', dir, 'commit', '-m', message]);
  return staged;
}

/** Discard all working-tree changes (used to drop any files a read-only review session touched). */
export async function discardWorkingTreeChanges(dir: string): Promise<void> {
  await exec('git', ['-C', dir, 'checkout', '--', '.']).catch(() => {});
  await exec('git', ['-C', dir, 'clean', '-fd']).catch(() => {});
}

/** Push the current branch (with the same transient-404 retry + token re-mint as commitAndPush). */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  let repo = await refreshOriginToken(dir);
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await exec('git', ['-C', dir, 'push', 'origin', branch]);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /not found|could not resolve|timed out|connection|tls|ssl|remote end hung up|rpc failed/i.test(msg);
        if (!transient || attempt === 4) throw sanitizeGitAuthError(err);
        console.warn(`[push] attempt ${attempt} failed (${msg.split('\n')[0]}); retrying…`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        repo = await refreshOriginToken(dir);
      }
    }
  } finally {
    await exec('git', ['-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`]).catch(() => {});
  }
}

/** Open a PR, or return the existing one if the agent already opened it for this branch. */
export async function openPullRequest(
  octokit: Octokit,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PullRequestInfo> {
  const [owner, name] = repo.split('/');
  try {
    const { data } = await octokit.pulls.create({ owner, repo: name, head, base, title, body });
    return { number: data.number, url: data.html_url };
  } catch (err) {
    // If a PR for this head already exists (agent opened it), return that instead of failing.
    const existing = await octokit.pulls
      .list({ owner, repo: name, head: `${owner}:${head}`, state: 'open' })
      .then((r) => r.data[0])
      .catch(() => undefined);
    if (existing) return { number: existing.number, url: existing.html_url };
    throw err;
  }
}

export const HERMES_OUTCOME_REPORT_START = '<!-- hermes-outcome-report:start -->';
export const HERMES_OUTCOME_REPORT_END = '<!-- hermes-outcome-report:end -->';

const PR_BODY_PROPAGATION_INITIAL_DELAY_MS = 2_000;
const PR_BODY_PROPAGATION_POLL_DELAY_MS = 1_000;
const PR_BODY_PROPAGATION_STABLE_DELAY_MS = 1_000;
const PR_BODY_PROPAGATION_ATTEMPTS = 5;

type PullRequestBodyPropagationOptions = {
  attempts?: number;
  initialDelayMs?: number;
  pollDelayMs?: number;
  stableDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * GitHub can acknowledge a PR-body PATCH before a subsequent review-request webhook contains the
 * new body. Wait until two reads, separated by a short settling interval, return the exact body so
 * an automated reviewer cannot evaluate the stale merge record we just replaced.
 */
export async function waitForPullRequestBodyPropagation(
  octokit: Octokit,
  repo: string,
  prNumber: number,
  expectedBody: string,
  options: PullRequestBodyPropagationOptions = {}
): Promise<void> {
  const { owner, name } = splitRepo(repo);
  const attempts = options.attempts ?? PR_BODY_PROPAGATION_ATTEMPTS;
  const wait = options.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(
      attempt === 0
        ? (options.initialDelayMs ?? PR_BODY_PROPAGATION_INITIAL_DELAY_MS)
        : (options.pollDelayMs ?? PR_BODY_PROPAGATION_POLL_DELAY_MS)
    );
    try {
      const observed = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
      if (String(observed.data.body ?? '') !== expectedBody) continue;

      await wait(options.stableDelayMs ?? PR_BODY_PROPAGATION_STABLE_DELAY_MS);
      const stable = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
      if (String(stable.data.body ?? '') === expectedBody) return;
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? ` Last GitHub error: ${lastError.message}` : '';
  throw new Error(
    `GitHub did not expose the updated body for ${repo}#${prNumber} after ${attempts} checks.${detail}`
  );
}

/**
 * Replace the outcome-report portion of a Hermes PR body while preserving its task provenance,
 * validation summary, and review notes. New markers make every later metadata-only repair
 * deterministic; the heading/boundary fallback upgrades bodies created before markers existed.
 */
export function replacePullRequestOutcomeReport(body: string, report: string): string {
  const cleanReport = report.trim();
  if (!cleanReport) throw new Error('cannot update a PR body with an empty outcome report');
  const block = `${HERMES_OUTCOME_REPORT_START}\n${cleanReport}\n${HERMES_OUTCOME_REPORT_END}`;

  const markerStart = body.indexOf(HERMES_OUTCOME_REPORT_START);
  const markerEnd = body.indexOf(HERMES_OUTCOME_REPORT_END, Math.max(0, markerStart));
  if (markerStart >= 0 && markerEnd >= markerStart) {
    return `${body.slice(0, markerStart).trimEnd()}\n\n${block}\n\n${body
      .slice(markerEnd + HERMES_OUTCOME_REPORT_END.length)
      .trimStart()}`.trim();
  }

  const rootMatch = /^##\s+Root cause\b/im.exec(body);
  if (rootMatch) {
    const reportStart = rootMatch.index;
    const deferredMatch = /^##\s+Deferred\b/im.exec(body.slice(reportStart));
    if (deferredMatch) {
      const deferredStart = reportStart + deferredMatch.index;
      const boundaryMatch = /\n---\s*(?:\n|$)/.exec(body.slice(deferredStart));
      const reportEnd = boundaryMatch ? deferredStart + boundaryMatch.index : body.length;
      return `${body.slice(0, reportStart).trimEnd()}\n\n${block}\n\n${body.slice(reportEnd).trimStart()}`.trim();
    }
  }

  const gateBoundary = /\n---\s*\n\s*\*\*Pre-commit gate:/i.exec(body);
  const insertionPoint = gateBoundary?.index ?? body.length;
  return `${body.slice(0, insertionPoint).trimEnd()}\n\n${block}\n\n${body.slice(insertionPoint).trimStart()}`.trim();
}

export async function updatePullRequestOutcomeReport(
  octokit: Octokit,
  repo: string,
  prNumber: number,
  report: string
): Promise<void> {
  const { owner, name } = splitRepo(repo);
  const current = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  const body = replacePullRequestOutcomeReport(String(current.data.body ?? ''), report);
  await octokit.pulls.update({ owner, repo: name, pull_number: prNumber, body });
  await waitForPullRequestBodyPropagation(octokit, repo, prNumber, body);
}

/** Requeue human reviewers after a metadata-only fix, which does not produce a new commit event. */
export async function requestReReviewFromChangeRequesters(
  octokit: Octokit,
  repo: string,
  prNumber: number
): Promise<string[]> {
  try {
    const { owner, name } = splitRepo(repo);
    const pr = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
    const alreadyPending = new Set(
      (pr.data.requested_reviewers ?? []).map((reviewer) =>
        String((reviewer as { login?: string }).login ?? '').toLowerCase()
      )
    );
    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo: name,
      pull_number: prNumber,
      per_page: 100,
    });
    const latest = new Map<string, string>();
    for (const review of reviews) {
      const login = review.user?.login;
      const state = String(review.state ?? '').toUpperCase();
      if (!login || review.user?.type === 'Bot' || state === 'COMMENTED') continue;
      latest.set(login, state);
    }
    const reviewers = [...latest.entries()]
      .filter(([login, state]) => state === 'CHANGES_REQUESTED' && !alreadyPending.has(login.toLowerCase()))
      .map(([login]) => login);
    if (reviewers.length) {
      await octokit.pulls.requestReviewers({ owner, repo: name, pull_number: prNumber, reviewers });
    }
    return reviewers;
  } catch (err) {
    console.warn(
      `[github] failed to re-request review on ${repo}#${prNumber}:`,
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Post a comment on a pull request (PR comments are issue comments) so the fix Hermes just
 * pushed is visible on the PR itself, not only in Jira/Slack. Best-effort — never throws into
 * the job pipeline.
 */
export async function commentOnPullRequest(octokit: Octokit, repo: string, prNumber: number, body: string): Promise<void> {
  const { owner, name } = splitRepo(repo);
  try {
    await octokit.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
  } catch (err) {
    console.warn(`[github] failed to comment on ${repo}#${prNumber}:`, err instanceof Error ? err.message : String(err));
  }
}

export const HERMES_REVIEW_REPLY_MARKER_PREFIX = '<!-- hermes-review-addressed:';

export function reviewReplyMarker(feedbackCommentId: string): string {
  // GraphQL node ids are opaque but currently URL-safe. Restrict the value before placing it in an
  // HTML comment so corrupted job data cannot alter the visible reply.
  const safeId = String(feedbackCommentId).replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 180);
  if (!safeId) throw new Error('review reply target is missing a valid feedback comment id');
  return `${HERMES_REVIEW_REPLY_MARKER_PREFIX}${safeId} -->`;
}

export function addressedReviewReplyBody(feedbackCommentId: string, headSha: string): string {
  return [
    `🤖 Addressed this feedback in commit \`${headSha.slice(0, 7)}\`.`,
    '',
    'CI is rerunning; please re-review after it passes.',
    reviewReplyMarker(feedbackCommentId),
  ].join('\n');
}

async function createReviewCommentReply(
  octokit: Octokit,
  repo: string,
  prNumber: number,
  target: ReviewReplyTarget,
  body: string
): Promise<void> {
  const { owner, name } = splitRepo(repo);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // GitHub requires the numeric id of the thread's top-level comment; replies-to-replies are
      // rejected. The control plane captures that root id when it reads the GraphQL thread.
      await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies', {
        owner,
        repo: name,
        pull_number: prNumber,
        comment_id: target.rootCommentId,
        body,
      });
      return;
    } catch (err) {
      lastError = err;
      const status = Number((err as { status?: number })?.status ?? 0);
      const message = err instanceof Error ? err.message : String(err);
      const retryable =
        status === 0 ||
        status === 408 ||
        status === 429 ||
        status >= 500 ||
        (status === 403 && /rate limit|secondary rate/i.test(message));
      if (!retryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

export interface ReviewReplyResult {
  posted: number;
  alreadyPresent: number;
}

/**
 * Reply directly to every inline review thread addressed by a follow-up commit.
 *
 * The hidden per-feedback marker makes the operation idempotent: if a worker retries after a
 * partial write, already-posted acknowledgements are discovered and skipped.
 */
export async function replyToAddressedReviewComments(
  octokit: Octokit,
  repo: string,
  prNumber: number,
  targets: ReviewReplyTarget[],
  headSha: string
): Promise<ReviewReplyResult> {
  if (!targets.length) return { posted: 0, alreadyPresent: 0 };

  const { owner, name } = splitRepo(repo);
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
    owner,
    repo: name,
    pull_number: prNumber,
    per_page: 100,
  });
  const bodies = comments.map((comment) => String(comment.body ?? ''));
  const uniqueTargets = [...new Map(targets.map((target) => [target.feedbackCommentId, target])).values()];
  let posted = 0;
  let alreadyPresent = 0;

  for (const target of uniqueTargets) {
    const marker = reviewReplyMarker(target.feedbackCommentId);
    if (bodies.some((body) => body.includes(marker))) {
      alreadyPresent++;
      continue;
    }
    const body = addressedReviewReplyBody(target.feedbackCommentId, headSha);
    await createReviewCommentReply(octokit, repo, prNumber, target, body);
    bodies.push(body);
    posted++;
  }

  return { posted, alreadyPresent };
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
        // Another worker/control-plane task may have created the label concurrently.
        if (createErr?.status !== 422) throw createErr;
      });
  }
}

export async function ensurePullRequestLabels(
  octokit: Octokit,
  repo: string,
  pullNumber: number,
  labels: string[]
): Promise<void> {
  const uniqueLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!uniqueLabels.length) return;

  const { owner, name } = splitRepo(repo);
  await Promise.all(uniqueLabels.map((label) => ensureRepositoryLabel(octokit, repo, label)));
  await octokit.issues.addLabels({ owner, repo: name, issue_number: pullNumber, labels: uniqueLabels });
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

function summarizeWorkflowRun(run: any): WorkflowRunSummary {
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

export async function fetchWorkflowRunLogs(token: string, repo: string, runId: number): Promise<string> {
  const { owner, name } = splitRepo(repo);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const jobsRes = await fetch(`https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/jobs?per_page=100`, { headers });
  if (!jobsRes.ok) throw new Error(`GitHub jobs lookup failed ${jobsRes.status}: ${(await jobsRes.text()).slice(0, 300)}`);
  const jobs = ((await jobsRes.json()) as any).jobs ?? [];
  const chunks: string[] = [];

  for (const job of jobs) {
    if (!job?.id) continue;
    const logRes = await fetch(`https://api.github.com/repos/${owner}/${name}/actions/jobs/${job.id}/logs`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/plain' },
    });
    if (!logRes.ok) continue;
    chunks.push(`--- ${job.name ?? job.id} ---\n${await logRes.text()}`);
  }

  return chunks.join('\n\n');
}

export interface WorkflowArtifactSummary {
  id: number;
  name: string;
  sizeInBytes?: number;
  archiveDownloadUrl?: string;
  expired?: boolean;
}

export async function assertWorkflowExists(octokit: Octokit, repo: string, workflowId: string): Promise<void> {
  const { owner, name } = splitRepo(repo);
  await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', {
    owner,
    repo: name,
    workflow_id: workflowId,
  });
}

export async function latestWorkflowRunForCommit(
  octokit: Octokit,
  repo: string,
  workflowId: string,
  headSha: string,
  branch?: string
): Promise<WorkflowRunSummary | null> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner,
    repo: name,
    workflow_id: workflowId,
    branch,
    per_page: 50,
  });
  const runs = (res.data.workflow_runs ?? []) as any[];
  const match = runs.find((run) => run.head_sha === headSha);
  if (!match) return null;
  return summarizeWorkflowRun(match);
}

export async function latestSupersedingWorkflowRunForCommit(
  octokit: Octokit,
  repo: string,
  workflowId: string,
  headSha: string,
  branch: string,
  createdAfter?: string | null
): Promise<WorkflowRunSummary | null> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner,
    repo: name,
    workflow_id: workflowId,
    branch,
    per_page: 25,
  });
  const createdAfterTime = createdAfter ? Date.parse(createdAfter) : 0;
  const candidates = ((res.data.workflow_runs ?? []) as any[]).filter((run) => {
    if (!run.head_sha || run.head_sha === headSha) return false;
    if (!createdAfterTime) return true;
    return Date.parse(run.created_at ?? '') >= createdAfterTime;
  });

  for (const candidate of candidates) {
    try {
      const comparison = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner,
        repo: name,
        basehead: `${headSha}...${candidate.head_sha}`,
      });
      if (comparison.data.status === 'ahead' || comparison.data.status === 'identical') {
        return summarizeWorkflowRun(candidate);
      }
    } catch (err: any) {
      if (err?.status !== 404 && err?.status !== 422) throw err;
    }
  }
  return null;
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

async function latestCheckRunForCommit(
  octokit: Octokit,
  repo: string,
  workflowId: string,
  headSha: string
): Promise<WorkflowRunSummary | null> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo: name,
    ref: headSha,
    per_page: 100,
  });
  const runs = ((res.data.check_runs ?? []) as any[]).filter((run) =>
    String(run.details_url ?? run.html_url ?? '').includes('/actions/runs/')
  );
  if (!runs.length) return null;

  const hints = workflowCheckHints(workflowId);
  const matching = runs.filter((run) => {
    const runName = String(run.name ?? '').toLowerCase();
    return hints.some((hint) => runName.includes(hint) || hint.includes(runName));
  });
  const candidates = matching.length ? matching : runs.length === 1 ? runs : [];
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

export async function waitForWorkflowRunConclusion(input: {
  octokit: Octokit;
  repo: string;
  workflowId: string;
  headSha: string;
  branch?: string;
  timeoutSeconds: number;
  pollSeconds: number;
  followSupersedingRuns?: boolean;
  supersedingRunGraceSeconds?: number;
}): Promise<WorkflowRunSummary> {
  const started = Date.now();
  let last: WorkflowRunSummary | null = null;
  let lastCancelledRunId: number | null = null;
  let cancelledObservedAt = 0;
  while (Date.now() - started < input.timeoutSeconds * 1000) {
    try {
      last = await latestWorkflowRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha, input.branch);
    } catch {
      last = await latestCheckRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha);
    }
    if (!last) {
      last = await latestCheckRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha);
    }
    if (last?.status === 'completed') {
      if (last.conclusion !== 'cancelled' || !input.followSupersedingRuns || !input.branch) {
        return last;
      }

      const exactCancelledRun = last;
      const supersedingRun = await latestSupersedingWorkflowRunForCommit(
        input.octokit,
        input.repo,
        input.workflowId,
        input.headSha,
        input.branch,
        exactCancelledRun.createdAt
      );
      last = supersedingRun ?? exactCancelledRun;

      if (last.status === 'completed' && last.conclusion !== 'cancelled') {
        return last;
      }

      if (last.status === 'completed' && last.conclusion === 'cancelled') {
        if (lastCancelledRunId !== last.id) {
          lastCancelledRunId = last.id;
          cancelledObservedAt = Date.now();
        }
        const graceSeconds = input.supersedingRunGraceSeconds ?? 300;
        if (Date.now() - cancelledObservedAt >= graceSeconds * 1000) {
          return last;
        }
      } else {
        lastCancelledRunId = null;
        cancelledObservedAt = 0;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollSeconds * 1000));
  }
  throw new Error(
    `Timed out waiting for ${input.workflowId} on ${input.headSha.slice(0, 12)}${last ? ` (last status ${last.status})` : ''}`
  );
}

export async function dispatchWorkflow(input: {
  octokit: Octokit;
  repo: string;
  workflowId: string;
  ref: string;
  inputs: Record<string, string>;
}): Promise<void> {
  const { owner, name } = splitRepo(input.repo);
  await input.octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
    owner,
    repo: name,
    workflow_id: input.workflowId,
    ref: input.ref,
    inputs: input.inputs,
  });
}

export async function latestWorkflowDispatchRun(input: {
  octokit: Octokit;
  repo: string;
  workflowId: string;
  branch: string;
  createdAfterIso: string;
}): Promise<WorkflowRunSummary | null> {
  const { owner, name } = splitRepo(input.repo);
  const res = await input.octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner,
    repo: name,
    workflow_id: input.workflowId,
    branch: input.branch,
    event: 'workflow_dispatch',
    per_page: 25,
  });
  const after = Date.parse(input.createdAfterIso);
  const runs = ((res.data.workflow_runs ?? []) as any[]).filter((run) => Date.parse(run.created_at) >= after - 30_000);
  const match = runs[0];
  if (!match) return null;
  return {
    id: match.id,
    name: match.name,
    status: match.status,
    conclusion: match.conclusion,
    htmlUrl: match.html_url,
    headSha: match.head_sha,
    createdAt: match.created_at,
  };
}

export async function waitForDispatchedWorkflowConclusion(input: {
  octokit: Octokit;
  repo: string;
  workflowId: string;
  branch: string;
  createdAfterIso: string;
  timeoutSeconds: number;
  pollSeconds: number;
}): Promise<WorkflowRunSummary> {
  const started = Date.now();
  let last: WorkflowRunSummary | null = null;
  while (Date.now() - started < input.timeoutSeconds * 1000) {
    last = await latestWorkflowDispatchRun(input);
    if (last?.status === 'completed') return last;
    await new Promise((resolve) => setTimeout(resolve, input.pollSeconds * 1000));
  }
  throw new Error(`Timed out waiting for dispatched ${input.workflowId}${last ? ` (last status ${last.status})` : ''}`);
}

export async function listWorkflowArtifacts(octokit: Octokit, repo: string, runId: number): Promise<WorkflowArtifactSummary[]> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
    owner,
    repo: name,
    run_id: runId,
    per_page: 100,
  });
  return (res.data.artifacts ?? []).map((artifact: any) => ({
    id: artifact.id,
    name: artifact.name,
    sizeInBytes: artifact.size_in_bytes,
    archiveDownloadUrl: artifact.archive_download_url,
    expired: artifact.expired,
  }));
}
