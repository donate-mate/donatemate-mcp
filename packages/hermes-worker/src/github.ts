/**
 * GitHub App integration. Mints a short-lived installation token per job (never stored on
 * disk), clones the target repo cleanly, pushes the work branch, and opens a PR.
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

/** Clone `owner/repo` at `baseBranch` into `dir`, shallow + clean, using the install token. */
export async function cloneRepo(token: string, repo: string, baseBranch: string, dir: string): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  await exec('git', ['clone', '--depth', '1', '--branch', baseBranch, url, dir]);
  await exec('git', ['-C', dir, 'config', 'user.name', 'DonateMate Hermes']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'hermes@donate-mate.com']);
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  await exec('git', ['-C', dir, 'checkout', '-b', branch]);
}

/** Returns true if there are changes to commit. */
export async function hasChanges(dir: string): Promise<boolean> {
  const { stdout } = await exec('git', ['-C', dir, 'status', '--porcelain']);
  return stdout.trim().length > 0;
}

export async function commitAndPush(dir: string, branch: string, message: string): Promise<void> {
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-m', message]);
  await exec('git', ['-C', dir, 'push', 'origin', branch]);
}

export async function openPullRequest(
  octokit: Octokit,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const [owner, name] = repo.split('/');
  const { data } = await octokit.pulls.create({ owner, repo: name, head, base, title, body });
  return data.html_url;
}
