process.env.AWS_REGION ??= 'us-east-2';

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runGate, runGateCommand } from './gate.js';

const exec = promisify(execFile);
const cleanup: string[] = [];

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args]);
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runGate merge-conflict scope', () => {
  it('validates the PR net diff without treating clean incoming base changes as PR changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-gate-test-'));
    cleanup.push(dir);
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Hermes test');
    await git(dir, 'config', 'user.email', 'hermes-test@example.com');

    for (const name of ['base-only', 'pr-change']) {
      const root = join(dir, 'packages', name);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@test/${name}` }));
      await writeFile(join(root, 'value.txt'), 'initial\n');
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'initial');
    const initialSha = await git(dir, 'rev-parse', 'HEAD');

    await git(dir, 'checkout', '-b', 'pr');
    await writeFile(join(dir, 'packages', 'pr-change', 'value.txt'), 'changed by PR\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'PR change');

    await git(dir, 'checkout', 'main');
    await writeFile(join(dir, 'packages', 'base-only', 'value.txt'), 'changed on main\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'main change');
    const mainSha = await git(dir, 'rev-parse', 'HEAD');

    await git(dir, 'checkout', 'pr');
    await git(dir, 'merge', '--no-edit', mainSha);
    expect(await git(dir, 'merge-base', initialSha, mainSha)).toBe(initialSha);

    const gate = await runGate(dir, mainSha, false);

    expect(gate.changedPackages).toEqual(['@test/pr-change']);
  });
});

describe('runGateCommand timeout', () => {
  it('terminates command descendants and reports a non-zero timeout result', async () => {
    const grandchild = 'setTimeout(() => process.exit(0), 3000);';
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const startedAt = Date.now();

    const result = await runGateCommand(process.execPath, ['-e', parent], process.cwd(), 100);

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('overrides a successful parent exit when inherited pipes remain open past the deadline', async () => {
    const grandchild = 'setTimeout(() => process.exit(0), 3000);';
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    ].join('');

    const result = await runGateCommand(process.execPath, ['-e', parent], process.cwd(), 100);

    expect(result).toMatchObject({ timedOut: true, code: 124 });
  });
});
