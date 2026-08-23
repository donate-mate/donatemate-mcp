process.env.AWS_REGION ??= 'us-east-2';

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConcurrentBranchUpdateError,
  isNonFastForwardPushError,
  reconcileRemoteBranchUpdate,
} from './github.js';

const run = promisify(execFile);
const roots: string[] = [];

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args]);
  return stdout.trim();
}

async function commitFile(dir: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(join(dir, file), contents);
  await git(dir, 'add', file);
  await git(dir, 'commit', '-m', message);
}

async function configureAuthor(dir: string): Promise<void> {
  await git(dir, 'config', 'user.name', 'Hermes branch-race test');
  await git(dir, 'config', 'user.email', 'hermes-test@donate-mate.com');
}

async function branchRaceRepos(): Promise<{ origin: string; hermes: string; updater: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hermes-branch-race-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const hermes = join(root, 'hermes');
  const updater = join(root, 'updater');

  await run('git', ['init', '--bare', '--initial-branch=main', origin]);
  await run('git', ['clone', origin, seed]);
  await configureAuthor(seed);
  await commitFile(seed, 'shared.txt', 'base\n', 'base');
  await git(seed, 'push', 'origin', 'HEAD:main');
  await git(seed, 'checkout', '-b', 'hermes/test');
  await commitFile(seed, 'feature.txt', 'existing PR work\n', 'existing PR work');
  await git(seed, 'push', '--set-upstream', 'origin', 'hermes/test');

  await run('git', ['clone', '--branch', 'hermes/test', origin, hermes]);
  await run('git', ['clone', '--branch', 'hermes/test', origin, updater]);
  await configureAuthor(hermes);
  await configureAuthor(updater);
  return { origin, hermes, updater };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Hermes PR branch concurrency', () => {
  it('recognizes the non-fast-forward rejection emitted by GitHub', () => {
    expect(
      isNonFastForwardPushError({
        stderr:
          "! [rejected] hermes/test -> hermes/test (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind",
      })
    ).toBe(true);
    expect(isNonFastForwardPushError(new Error('remote: protected branch hook declined'))).toBe(false);
  });

  it('merges an auto-update commit and leaves a normal fast-forward push', async () => {
    const { origin, hermes, updater } = await branchRaceRepos();
    await commitFile(hermes, 'hermes.txt', 'completed follow-up\n', 'Hermes follow-up');
    await commitFile(updater, 'auto-update.txt', 'new main content\n', 'Auto-update branch');
    await git(updater, 'push', 'origin', 'hermes/test');

    const result = await reconcileRemoteBranchUpdate(hermes, 'hermes/test');

    await expect(readFile(join(hermes, 'hermes.txt'), 'utf8')).resolves.toBe('completed follow-up\n');
    await expect(readFile(join(hermes, 'auto-update.txt'), 'utf8')).resolves.toBe('new main content\n');
    await expect(git(hermes, 'merge-base', '--is-ancestor', result.remoteSha, 'HEAD')).resolves.toBe('');
    await git(hermes, 'push', 'origin', 'hermes/test');
    expect(await git(origin, 'rev-parse', 'refs/heads/hermes/test')).toBe(await git(hermes, 'rev-parse', 'HEAD'));
  }, 15_000);

  it('aborts a conflicting merge and preserves the local follow-up for a durable retry', async () => {
    const { hermes, updater } = await branchRaceRepos();
    await commitFile(hermes, 'shared.txt', 'Hermes change\n', 'Hermes overlapping follow-up');
    const localHead = await git(hermes, 'rev-parse', 'HEAD');
    await commitFile(updater, 'shared.txt', 'auto-update change\n', 'Auto-update overlapping change');
    await git(updater, 'push', 'origin', 'hermes/test');

    await expect(reconcileRemoteBranchUpdate(hermes, 'hermes/test')).rejects.toBeInstanceOf(
      ConcurrentBranchUpdateError
    );
    expect(await git(hermes, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(await git(hermes, 'status', '--porcelain')).toBe('');
    await expect(readFile(join(hermes, 'shared.txt'), 'utf8')).resolves.toBe('Hermes change\n');
  }, 15_000);
});
