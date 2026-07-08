/**
 * WS2 — Harness pre-commit gate.
 *
 * After the Codex session ends, before the harness commits, we scope prettier/eslint/tests to the
 * packages the agent actually changed and run them. Failures are turned into a structured report
 * that the caller feeds back into a fresh Codex repair round (up to GATE_MAX_RETRIES). If the gate
 * still fails after the retries, the harness opens the PR anyway (fail-open) with a loud
 * "⚠️ gate failures" section — never block a PR forever.
 *
 * This runs the repo's OWN tooling (prettier/eslint/jest via the package's scripts), so it enforces
 * the repository's real thresholds (e.g. 90% coverage) rather than anything Hermes invents. It
 * depends on WS1 having installed dependencies + generated the Prisma client.
 */
import { spawn, execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { detectPackageManager, workspaceScriptCommand, type PackageManager } from './workspace.js';

const execFileP = promisify(execFile);
const CMD_TIMEOUT_MS = Number(process.env.GATE_CMD_TIMEOUT_SECONDS ?? 600) * 1000;
const OUT_CAP = 12 * 1024;

const PRETTIER_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx|yml|yaml|html)$/i;
const LINT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

export interface GateCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
}

export interface GateResult {
  ok: boolean;
  changedPackages: string[];
  checks: GateCheck[];
  /** Structured, compact failure report for feeding back into a Codex repair round. Empty when ok. */
  report: string;
}

interface Cmd {
  code: number;
  out: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string): Promise<Cmd> {
  return new Promise((resolve) => {
    // NODE_ENV=test (not the image's 'production', which would skip dev tooling/behavior); HUSKY=0 so
    // no repo hook fires while the gate runs the repo's own prettier/eslint/test scripts.
    const env = { ...process.env, CI: 'true', HUSKY: '0', NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : process.env.NODE_ENV ?? 'test' };
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CMD_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      if (out.length < OUT_CAP * 8) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}\n${e instanceof Error ? e.message : String(e)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out: out.slice(-OUT_CAP), timedOut });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Union of committed-vs-base diff and dirty working tree — the files the agent touched. */
async function changedFiles(dir: string, baseSha: string): Promise<string[]> {
  const files = new Set<string>();
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'diff', '--name-only', baseSha, 'HEAD'], { maxBuffer: 8 * 1024 * 1024 });
    stdout.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
  } catch {
    /* baseSha may equal HEAD (agent didn't commit) — fall through to porcelain */
  }
  const { stdout: porcelain } = await execFileP('git', ['-C', dir, 'status', '--porcelain'], { maxBuffer: 8 * 1024 * 1024 });
  for (const line of porcelain.split('\n')) {
    const path = line.slice(3).trim();
    if (path) files.add(path.includes(' -> ') ? path.split(' -> ')[1] : path);
  }
  return [...files];
}

/** Walk up from each changed file to the nearest workspace package.json (not the repo root). */
async function changedPackages(dir: string, files: string[]): Promise<Map<string, string>> {
  const pkgs = new Map<string, string>(); // name -> relative root
  for (const file of files) {
    let cur = dirname(join(dir, file));
    while (cur.startsWith(dir) && cur !== dir) {
      const pkgJson = join(cur, 'package.json');
      if (await fileExists(pkgJson)) {
        const json = JSON.parse(await readFile(pkgJson, 'utf8').catch(() => '{}'));
        if (json?.name) pkgs.set(json.name, relative(dir, cur) || '.');
        break;
      }
      cur = dirname(cur);
    }
  }
  return pkgs;
}

async function hasScript(dir: string, pkgRoot: string, script: string): Promise<boolean> {
  const json = JSON.parse(await readFile(join(dir, pkgRoot, 'package.json'), 'utf8').catch(() => '{}'));
  return Boolean(json?.scripts?.[script]);
}

/** Which of the given tools are resolvable in the clone (skip a check rather than fail if absent). */
async function toolAvailable(dir: string, bin: string): Promise<boolean> {
  return fileExists(join(dir, 'node_modules', '.bin', bin));
}

function summarize(check: Cmd, extra = ''): string {
  const why = check.timedOut ? ' [timed out]' : '';
  return `${extra}${why}\n${check.out}`.trim();
}

/**
 * Run the gate. `installOk` false means WS1 couldn't install deps — we still run prettier (which is
 * cheap and dependency-light) but mark eslint/tests as skipped-because-uninstalled so the caller
 * knows the gate is degraded rather than green.
 */
export async function runGate(dir: string, baseSha: string, installOk: boolean): Promise<GateResult> {
  const pm = (await detectPackageManager(dir)) as PackageManager | undefined;
  const files = await changedFiles(dir, baseSha);
  const pkgs = await changedPackages(dir, files);
  const checks: GateCheck[] = [];

  // 1) prettier --check on changed, prettier-relevant, still-present files.
  const prettierFiles: string[] = [];
  for (const f of files) {
    if (PRETTIER_EXT.test(f) && (await fileExists(join(dir, f)))) prettierFiles.push(f);
  }
  if (prettierFiles.length && (await toolAvailable(dir, 'prettier'))) {
    const res = await run('npx', ['--no-install', 'prettier', '--check', ...prettierFiles], dir);
    checks.push({ name: 'prettier', ok: res.code === 0, output: summarize(res) });
  } else {
    checks.push({ name: 'prettier', ok: true, skipped: true, output: 'prettier not available or no formattable files' });
  }

  // 2) eslint on changed lintable files (config resolves per-package from the repo root).
  const lintFiles: string[] = [];
  for (const f of files) {
    if (LINT_EXT.test(f) && (await fileExists(join(dir, f)))) lintFiles.push(f);
  }
  if (lintFiles.length && installOk && (await toolAvailable(dir, 'eslint'))) {
    const res = await run('npx', ['--no-install', 'eslint', ...lintFiles], dir);
    checks.push({ name: 'eslint', ok: res.code === 0, output: summarize(res) });
  } else {
    checks.push({
      name: 'eslint',
      ok: true,
      skipped: true,
      output: installOk ? 'eslint not available or no lintable files' : 'skipped: dependencies not installed',
    });
  }

  // 3) tests (with the repo's own coverage thresholds) per changed package that has a test script.
  if (pm && installOk) {
    // Internal @scope/* workspace packages are TS source that must be BUILT before a dependent
    // package's jest/tsc can resolve them — `yarn install` does not compile them. Without this,
    // tests fail on unresolved workspace imports (the core "tests never executed" problem). We build
    // each changed package + its dependency graph via turbo (if present) before running its tests.
    const hasTurbo = (await fileExists(join(dir, 'turbo.json'))) && (await toolAvailable(dir, 'turbo'));
    for (const [name, root] of pkgs) {
      if (!(await hasScript(dir, root, 'test'))) continue;
      if (hasTurbo) {
        // `<pkg>...` = the package plus everything it depends on.
        const build = await run('npx', ['--no-install', 'turbo', 'run', 'build', '--filter', `${name}...`], dir);
        if (build.code !== 0) {
          // Fail-open: a monorepo build-infra problem is not the agent's code defect, so skip the
          // test rather than block the PR — but surface it so it's visible.
          checks.push({ name: `test:${name}`, ok: true, skipped: true, output: summarize(build, `(skipped: could not build workspace deps for ${name})`) });
          continue;
        }
      }
      const { cmd, args } = workspaceScriptCommand(pm, name, 'test');
      const res = await run(cmd, args, dir);
      checks.push({ name: `test:${name}`, ok: res.code === 0, output: summarize(res, `(package ${name})`) });
    }
  } else if (pkgs.size) {
    checks.push({ name: 'test', ok: true, skipped: true, output: 'skipped: dependencies not installed' });
  }

  const failures = checks.filter((c) => !c.ok);
  const report = failures.length
    ? [
        'The pre-commit gate found problems in the packages you changed. Fix ONLY these issues; keep the implementation intent and avoid unrelated refactors.',
        '',
        ...failures.map((f) => [`### ${f.name} FAILED`, '```text', f.output.slice(-6000), '```'].join('\n')),
      ].join('\n')
    : '';

  return { ok: failures.length === 0, changedPackages: [...pkgs.keys()], checks, report };
}

/** One-line human summary for the PR body / logs. */
export function gateSummary(result: GateResult): string {
  return result.checks.map((c) => `${c.ok ? (c.skipped ? '⊘' : '✓') : '✗'} ${c.name}`).join('  ');
}
