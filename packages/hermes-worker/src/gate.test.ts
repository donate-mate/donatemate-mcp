process.env.AWS_REGION ??= 'us-east-2';

import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runGate, runGateCommand } from './gate.js';
import { InfrastructureCommandTimeoutError } from './agent.js';

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
  it('terminates command descendants and requires a clean container before retry', async () => {
    const grandchild = 'setTimeout(() => process.exit(0), 3000);';
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const startedAt = Date.now();

    await expect(runGateCommand(process.execPath, ['-e', parent], process.cwd(), 100)).rejects.toBeInstanceOf(
      InfrastructureCommandTimeoutError
    );
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('requires a clean container when a successful parent leaves inherited pipes open', async () => {
    const grandchild = 'setTimeout(() => process.exit(0), 3000);';
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    ].join('');

    await expect(runGateCommand(process.execPath, ['-e', parent], process.cwd(), 100)).rejects.toBeInstanceOf(
      InfrastructureCommandTimeoutError
    );
  });

  it('can report a bounded non-daemon command timeout without restarting the container', async () => {
    const result = await runGateCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000);'],
      process.cwd(),
      100,
      { restartContainerOnTimeout: false }
    );

    expect(result).toMatchObject({ code: 124, timedOut: true });
  });
});

describe('runGate validation sequencing', () => {
  it('repairs cheap failures before starting the workspace dependency build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-gate-sequencing-'));
    cleanup.push(dir);
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Hermes test');
    await git(dir, 'config', 'user.email', 'hermes-test@example.com');

    const packageRoot = join(dir, 'packages', 'example');
    const binRoot = join(dir, 'node_modules', '.bin');
    const turboMarker = join(dir, 'turbo-ran');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'node_modules/\nturbo-ran\n');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] })
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeFile(join(dir, 'turbo.json'), '{}');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@test/example', scripts: { test: 'node -e \"\"' } })
    );
    await writeFile(join(packageRoot, 'index.ts'), 'export const value = 1;\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'initial');
    const baseSha = await git(dir, 'rev-parse', 'HEAD');

    await writeFile(join(packageRoot, 'index.ts'), 'export const value = 2;\n');
    await writeFile(join(binRoot, 'prettier'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    await writeFile(join(binRoot, 'eslint'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    await writeFile(
      join(binRoot, 'turbo'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(turboMarker)}, 'ran');\n`
    );
    await Promise.all(
      ['prettier', 'eslint', 'turbo'].map((name) => chmod(join(binRoot, name), 0o755))
    );

    const gate = await runGate(dir, baseSha, true);

    expect(gate.ok).toBe(false);
    expect(gate.checks.map((check) => check.name)).toEqual(['prettier', 'eslint']);
    await expect(access(turboMarker)).rejects.toThrow();
  });
});
