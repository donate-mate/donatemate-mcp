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
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
      actions: 'write',
      metadata: 'read',
    },
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
  try {
    const { stdout, stderr } = await exec('git', ['-C', dir, 'merge', '--no-edit', remoteBaseRef], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`.trim();
    return {
      status: /already up to date/i.test(output) ? 'already_up_to_date' : 'merged_cleanly',
      output,
      conflicts: [],
    };
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').slice(0, 4000);
    const conflicts = await listUnmergedFiles(dir);
    if (conflicts.length || /\bCONFLICT \(|Automatic merge failed|fix conflicts/i.test(output)) {
      return { status: 'conflicted', output, conflicts };
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

  // Push with retry: a freshly-minted scoped installation token can transiently 404
  // ("Repository not found") from GitHub propagation lag — the clone path already retries this,
  // but push did not, so a one-off blip failed the whole job. Re-mint the token each attempt.
  let repo = await refreshOriginToken(dir);
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await exec('git', ['-C', dir, 'push', 'origin', branch]);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /not found|could not resolve|timed out|connection|tls|ssl|remote end hung up|rpc failed/i.test(msg);
        if (!transient || attempt === 4) throw sanitizeGitAuthError(err);
        console.warn(`[push] attempt ${attempt} failed (${msg.split('\n')[0]}); retrying…`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
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
}): Promise<WorkflowRunSummary> {
  const started = Date.now();
  let last: WorkflowRunSummary | null = null;
  while (Date.now() - started < input.timeoutSeconds * 1000) {
    try {
      last = await latestWorkflowRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha, input.branch);
    } catch {
      last = await latestCheckRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha);
    }
    if (!last) {
      last = await latestCheckRunForCommit(input.octokit, input.repo, input.workflowId, input.headSha);
    }
    if (last?.status === 'completed') return last;
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
