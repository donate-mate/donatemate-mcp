/**
 * WS1 — Working toolchain in the clone.
 *
 * The worker used to hand Codex a bare `git clone` with NO dependencies installed, so it could not
 * run `jest`/`tsc` (7/7 shipped PRs had never-executed tests). Worse, the naive fix
 * (`yarn install --frozen-lockfile --ignore-scripts`) leaves ts-jest unresolvable and the Prisma
 * client ungenerated. This module installs dependencies WITH lifecycle scripts and explicitly
 * generates any Prisma client, so the pre-commit gate (WS2) and the agent can execute real tests.
 *
 * Speed: at job time this is an incremental install. The nightly worker image (see
 * .github/workflows/hermes-images.yml) prebakes the yarn/turbo caches under HERMES_CACHE_DIR so the
 * install hits a warm cache instead of the network — first-edit target is < 2 min.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const INSTALL_TIMEOUT_MS = Number(process.env.WORKSPACE_INSTALL_TIMEOUT_SECONDS ?? 600) * 1000;
const LOG_CAP = 24 * 1024;

export interface InstallResult {
  /** true when the install (and prisma generate, if any) succeeded, or when there was nothing to install. */
  ok: boolean;
  /** true when the repo isn't a JS/TS workspace (no lockfile) — nothing to do. */
  skipped: boolean;
  packageManager?: 'yarn' | 'yarn-berry' | 'npm' | 'pnpm';
  log: string;
  durationMs: number;
}

interface CmdResult {
  code: number;
  out: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CI: 'true', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, INSTALL_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      if (out.length < LOG_CAP * 8) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}\n${e instanceof Error ? e.message : String(e)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out, timedOut });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export type PackageManager = NonNullable<InstallResult['packageManager']>;

/** Command to run a package.json script in a named workspace member, per package manager. */
export function workspaceScriptCommand(pm: PackageManager, pkgName: string, script: string, extraArgs: string[] = []): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['--filter', pkgName, 'run', script, ...extraArgs] };
    case 'npm':
      return { cmd: 'npm', args: ['run', script, '-w', pkgName, '--', ...extraArgs] };
    case 'yarn-berry':
    case 'yarn':
    default:
      return { cmd: 'yarn', args: ['workspace', pkgName, 'run', script, ...extraArgs] };
  }
}

export async function detectPackageManager(dir: string): Promise<InstallResult['packageManager'] | undefined> {
  const pkg = await readJson(join(dir, 'package.json'));
  const declared: string | undefined = pkg?.packageManager;
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(dir, 'yarn.lock'))) {
    // Berry (yarn 2+) uses `--immutable`; classic uses `--frozen-lockfile`.
    if ((declared && /^yarn@[2-9]/.test(declared)) || (await exists(join(dir, '.yarnrc.yml')))) return 'yarn-berry';
    return 'yarn';
  }
  if (await exists(join(dir, 'package-lock.json'))) return 'npm';
  if (declared?.startsWith('pnpm')) return 'pnpm';
  if (declared?.startsWith('yarn')) return 'yarn';
  return undefined;
}

function installCommand(pm: NonNullable<InstallResult['packageManager']>): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'npm':
      return { cmd: 'npm', args: ['ci'] };
    case 'yarn-berry':
      return { cmd: 'yarn', args: ['install', '--immutable'] };
    case 'yarn':
    default:
      return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
}

/** Warm-cache env: point yarn/turbo at the prebaked caches baked into the nightly image (if present). */
function cacheEnv(): NodeJS.ProcessEnv {
  const cacheDir = process.env.HERMES_CACHE_DIR;
  if (!cacheDir) return {};
  return {
    YARN_CACHE_FOLDER: process.env.YARN_CACHE_FOLDER ?? join(cacheDir, 'yarn'),
    npm_config_cache: process.env.npm_config_cache ?? join(cacheDir, 'npm'),
    TURBO_CACHE_DIR: process.env.TURBO_CACHE_DIR ?? join(cacheDir, 'turbo'),
  };
}

/** Locate prisma schemas that need `prisma generate` (client is emitted into node_modules per clone). */
async function findPrismaSchemas(dir: string): Promise<string[]> {
  const candidates = [
    'prisma/schema.prisma',
    'packages/database/prisma/schema.prisma',
    'packages/db/prisma/schema.prisma',
    'apps/api/prisma/schema.prisma',
  ];
  const found: string[] = [];
  for (const rel of candidates) {
    if (await exists(join(dir, rel))) found.push(rel);
  }
  return found;
}

/**
 * Install dependencies (with lifecycle scripts) and generate any Prisma client. Non-throwing:
 * returns `ok:false` with the captured log so the caller can proceed fail-open (open the PR with a
 * warning) rather than aborting the whole job on a flaky install.
 */
export async function installWorkspace(dir: string): Promise<InstallResult> {
  const started = Date.now();
  const pm = await detectPackageManager(dir);
  if (!pm) {
    return { ok: true, skipped: true, log: 'No JS/TS lockfile detected; skipping install.', durationMs: 0 };
  }
  const env = cacheEnv();
  const { cmd, args } = installCommand(pm);
  console.log(`[workspace] installing with ${cmd} ${args.join(' ')} (pm=${pm})`);
  const install = await run(cmd, args, dir, env);
  const logs: string[] = [`$ ${cmd} ${args.join(' ')}\n${install.out}`.slice(-LOG_CAP)];

  if (install.code !== 0) {
    const why = install.timedOut ? ' (timed out)' : '';
    return {
      ok: false,
      skipped: false,
      packageManager: pm,
      log: `Dependency install failed${why} (exit ${install.code}).\n\n${logs.join('\n\n')}`,
      durationMs: Date.now() - started,
    };
  }

  // Prisma client generation — the naive `--ignore-scripts` path is exactly what left this ungenerated.
  const schemas = await findPrismaSchemas(dir);
  let prismaOk = true;
  for (const schema of schemas) {
    const gen = await run('npx', ['--no-install', 'prisma', 'generate', `--schema=${schema}`], dir, env);
    logs.push(`$ npx prisma generate --schema=${schema}\n${gen.out}`.slice(-LOG_CAP));
    if (gen.code !== 0) prismaOk = false;
  }

  return {
    ok: prismaOk,
    skipped: false,
    packageManager: pm,
    log: logs.join('\n\n').slice(-LOG_CAP * 2),
    durationMs: Date.now() - started,
  };
}
