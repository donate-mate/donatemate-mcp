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
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcessWithTimeout } from './agent.js';

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

export function runWorkspaceCommand(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = INSTALL_TIMEOUT_MS
): Promise<CmdResult> {
  return runProcessWithTimeout({
    command: cmd,
    args,
    stdin: '',
    cwd,
    env: { ...process.env, CI: 'true', ...extraEnv },
    timeoutMs,
  })
    .then((result) => ({
      // Dependency setup is an optimization for local validation, not the coding job itself. The
      // process-tree runner has already killed the bounded command on timeout, so report a degraded
      // install and continue instead of terminating the worker and replaying the poison workspace.
      code: result.code,
      out: `${result.stdout}\n${result.stderr}`.trim().slice(-LOG_CAP),
      timedOut: result.timedOut,
    }))
    .catch((error) => ({
      code: 127,
      out: error instanceof Error ? error.message : String(error),
      timedOut: false,
    }));
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
  // CRITICAL install env:
  //  - NODE_ENV=development: the worker image sets NODE_ENV=production for its OWN runtime, but that
  //    leaks into the target-repo install and makes yarn/npm SKIP devDependencies — exactly the tools
  //    WS1/WS2 need (prisma, jest, ts-jest, eslint, prettier). Force dev so devDeps install.
  //  - HUSKY=0: the target repo's `prepare`/postinstall runs `husky install`, which fails (exit 127)
  //    and, worse, wires git hooks that then interfere with the harness's controlled commit/push.
  //    The harness owns validation via the WS2 gate + post-open CI, so repo hooks must stay disabled.
  const env = { ...cacheEnv(), NODE_ENV: 'development', HUSKY: '0', npm_config_production: 'false' };
  const { cmd, args } = installCommand(pm);
  console.log(`[workspace] installing with ${cmd} ${args.join(' ')} (pm=${pm})`);
  const install = await runWorkspaceCommand(cmd, args, dir, env);
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
    const gen = await runWorkspaceCommand('npx', ['--no-install', 'prisma', 'generate', `--schema=${schema}`], dir, env);
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
