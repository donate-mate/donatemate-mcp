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
 * Clone `owner/repo` at `baseBranch` into `dir`, shallow + clean, using the install token.
 * Retries a few times: a freshly-minted scoped installation token can briefly 404 ("Repository
 * not found") on clone due to GitHub token-propagation lag.
 */
export async function cloneRepo(token: string, repo: string, baseBranch: string, dir: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await exec('git', ['clone', '--depth', '1', '--branch', baseBranch, url, dir]);
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

export async function createBranch(dir: string, branch: string): Promise<void> {
  await exec('git', ['-C', dir, 'checkout', '-b', branch]);
}

/** SHA of the current HEAD (captured at branch creation as the pre-agent baseline). */
export async function getHeadSha(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
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
  // Commit only if something is staged — otherwise `git commit` errors with "nothing to commit".
  const staged = await exec('git', ['-C', dir, 'diff', '--cached', '--quiet']).then(
    () => false,
    () => true
  );
  if (staged) await exec('git', ['-C', dir, 'commit', '-m', message]);
  await exec('git', ['-C', dir, 'push', 'origin', branch]);
}

/** Open a PR, or return the existing one if the agent already opened it for this branch. */
export async function openPullRequest(
  octokit: Octokit,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const [owner, name] = repo.split('/');
  try {
    const { data } = await octokit.pulls.create({ owner, repo: name, head, base, title, body });
    return data.html_url;
  } catch (err) {
    // If a PR for this head already exists (agent opened it), return that instead of failing.
    const existing = await octokit.pulls
      .list({ owner, repo: name, head: `${owner}:${head}`, state: 'open' })
      .then((r) => r.data[0]?.html_url)
      .catch(() => undefined);
    if (existing) return existing;
    throw err;
  }
}
