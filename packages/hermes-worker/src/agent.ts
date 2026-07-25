/**
 * Coding engine: runs OpenAI Codex headless inside the cloned repo. We shell out to the `codex`
 * CLI (installed in the worker image) in non-interactive `codex exec` mode. The container is the
 * sandbox (ephemeral, isolated), so Codex runs with --dangerously-bypass-approvals-and-sandbox.
 * The model is pinned via AGENT_MODEL (default gpt-5.5). Hard timeout is the budget guardrail.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecretJson } from './secrets.js';

const SECRET_OPENAI = process.env.SECRET_OPENAI!;
const AGENT_MODEL = process.env.AGENT_MODEL || 'gpt-5.5';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;
const OUTPUT_CAP = 16 * 1024 * 1024;

// WS3.1 — reasoning effort. Codex takes `-c model_reasoning_effort=<minimal|low|medium|high>`.
// Default is env-configurable ("medium") for implementation jobs; the pre-open review session
// (WS4) passes "high" per call. Previously NO flag was passed, so Codex ran at its own default.
const VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const DEFAULT_REASONING_EFFORT = normalizeEffort(process.env.AGENT_REASONING_EFFORT) ?? 'medium';

function normalizeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  // Historic value "none" maps to Codex's lowest tier.
  const mapped = v === 'none' ? 'minimal' : v;
  return VALID_EFFORTS.has(mapped) ? mapped : undefined;
}

export interface RunAgentOptions {
  /** Override reasoning effort for this call (minimal|low|medium|high). Falls back to the env default. */
  reasoningEffort?: string;
  /** Override the model for this call (defaults to AGENT_MODEL). */
  model?: string;
  /**
   * Override the preamble prepended to the prompt. Defaults to HARNESS_PREAMBLE (which instructs the
   * agent to edit files). The WS4 pre-open review passes a read-only preamble instead so the review
   * session analyzes rather than mutates.
   */
  preamble?: string;
}

export interface AgentResult {
  transcript: string;
  exitCode: number;
  /** The agent's final message, truncated for Slack/Jira display and no-change explanations. */
  reason?: string;
  /** The agent's final message, untruncated — used by the WS4 review session to parse findings JSON. */
  finalMessage?: string;
  /** Whether the Codex session was killed by the JOB_TIMEOUT guardrail. */
  timedOut?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface RunProcessInput {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * A command timeout can leave a deliberately daemonized descendant outside the observable
 * process tree. Callers must let this error reach the worker loop so ECS replaces the container
 * before the SQS message is retried.
 */
export class ContainerRestartRequiredError extends Error {}

export class AgentTimeoutError extends ContainerRestartRequiredError {
  constructor(timeoutSeconds: number) {
    super(`Agent timed out after ${timeoutSeconds}s`);
    this.name = 'AgentTimeoutError';
  }
}

export class InfrastructureCommandTimeoutError extends ContainerRestartRequiredError {
  constructor(command: string, timeoutMs: number) {
    super(`Infrastructure command timed out after ${Math.ceil(timeoutMs / 1000)}s: ${command}`);
    this.name = 'InfrastructureCommandTimeoutError';
  }
}

// Authenticate the Codex CLI with the API key. `codex exec` reads auth from ~/.codex/auth.json,
// NOT from OPENAI_API_KEY (that env alone yields 401 on the /responses endpoint); the key must be
// written via `codex login --with-api-key` (reads the key from stdin).
function codexLogin(apiKey: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['login', '--with-api-key'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`codex login failed (exit ${code}): ${stderr.slice(0, 200)}`))
    );
    child.stdin.write(apiKey);
    child.stdin.end();
  });
}

// Keep prompts off argv. Linux limits each argument to roughly 128 KiB, which large pre-open
// review diffs can exceed. `codex exec -` reads the prompt from stdin; explicitly ending the pipe
// supplies EOF so Codex does not wait for more input.
/**
 * Return every live descendant while the root still owns the parent/child relationships. A
 * descendant remains visible here even if it called `setsid` or created another process group.
 */
function linuxDescendantPids(rootPid: number): number[] {
  if (process.platform !== 'linux') return [];
  const pending = [rootPid];
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  while (pending.length) {
    const pid = pending.pop()!;
    let raw = '';
    try {
      raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
    } catch {
      continue;
    }
    for (const value of raw.trim().split(/\s+/)) {
      const childPid = Number(value);
      if (!Number.isSafeInteger(childPid) || childPid <= 0 || seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between discovery and signalling.
  }
}

/**
 * Stop both the normal process group and descendants that escaped it with `setsid`/`detached`.
 * Descendants are snapshotted before the group leader is killed so they cannot be orphaned first.
 */
function terminateProcessTree(child: ReturnType<typeof spawn>, useProcessGroup: boolean): void {
  if (!child.pid) {
    child.kill('SIGKILL');
    return;
  }
  const descendants = linuxDescendantPids(child.pid);
  for (const pid of descendants.reverse()) signalProcess(pid, 'SIGKILL');
  if (useProcessGroup) signalProcess(-child.pid, 'SIGKILL');
  signalProcess(child.pid, 'SIGKILL');
}

/**
 * Run a command in its own POSIX process group so the timeout can terminate the complete tree.
 *
 * `codex exec` can launch tests, shells, and other descendants. Killing only the Codex PID leaves
 * those descendants alive with the stdout/stderr pipes open, so Node never emits `close` and the
 * Hermes job remains `running` indefinitely after its timeout.
 */
export function runProcessWithTimeout(input: RunProcessInput): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    timer = setTimeout(() => {
      terminateProcessTree(child, useProcessGroup);
      // Do not rely on every inherited writer closing before settling. Destroying our pipe ends
      // guarantees this invocation releases its listeners even if an unobservable descendant races
      // process discovery. The worker exits after recording AgentTimeoutError, so ECS then destroys
      // the entire container before SQS redelivery.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ stdout, stderr, code: 124, timedOut: true });
    }, input.timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on('error', (e) => {
      fail(e);
    });
    // A fast CLI failure can close stdin before the buffered prompt is flushed. The process exit
    // and stderr are the useful result in that case, so prevent EPIPE from becoming an unhandled
    // stream error.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') {
        fail(e);
      }
    });
    child.stdin.end(input.stdin);
    child.on('close', (code) => {
      finish({ stdout, stderr, code: code ?? 0, timedOut: false });
    });
  });
}

function runCodex(args: string[], prompt: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return runProcessWithTimeout({
    command: 'codex',
    args,
    stdin: prompt,
    cwd,
    env,
    timeoutMs: JOB_TIMEOUT_MS,
  });
}

// Prepended to every task. The harness owns git: the agent edits files only, so change-detection
// and PR creation stay deterministic and the agent can't open a malformed/duplicate PR.
const HARNESS_PREAMBLE = `You are running inside an automated CI harness, on a fresh shallow clone of the repository, on a new branch that has already been created for you.

Git is handled FOR you — do NOT manage it yourself:
- Make the required code changes by EDITING FILES in the working directory only.
- Do NOT run \`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`, or any \`gh\` command, and do NOT open a pull request. The harness automatically commits your working-tree changes and opens the PR after you finish.
- Leave your edits uncommitted in the working tree and end your turn when the change is complete.

AWS observability is available through the task role and the \`aws\` CLI. For backend defects, production/staging alerts, alarms, canary failures, or incident tickets:
- Use \`aws\` CLI evidence before changing code or alarm configuration. Check CloudWatch alarm history/metrics, Synthetics runs and artifacts, relevant CloudWatch Logs, and deployment/e2e timing for the reported window.
- Decide and state in your final message whether the alarm was a false positive, too sensitive/misconfigured, or correctly indicating defective source logic.
- If source logic is defective, fix the source logic directly and optimally. Do not hide real defects by only weakening alarms or adding superficial retries.
- If the alarm/canary is the defect, tune the canary/alarm with evidence and keep the production signal meaningful.

--- TASK ---

`;

export interface CodexExecInvocation {
  args: string[];
  stdin: string;
}

/** Build a size-safe invocation: prompt content is streamed, never included in process argv. */
export function buildCodexExecInvocation(input: {
  dir: string;
  lastMsgFile: string;
  model: string;
  effort: string;
  prompt: string;
}): CodexExecInvocation {
  return {
    args: [
      'exec',
      '--model',
      input.model,
      '-c',
      `model_reasoning_effort=${input.effort}`, // WS3.1
      '--dangerously-bypass-approvals-and-sandbox', // the Fargate container is the sandbox
      '--ephemeral', // don't persist session files
      '--skip-git-repo-check',
      '-C',
      input.dir,
      '-o',
      input.lastMsgFile,
      '-', // read the complete prompt from stdin
    ],
    stdin: input.prompt,
  };
}

export async function runAgent(dir: string, taskPrompt: string, opts: RunAgentOptions = {}): Promise<AgentResult> {
  const { apiKey } = await getSecretJson(SECRET_OPENAI);
  if (!apiKey) throw new Error('OpenAI API key not configured in Secrets Manager');
  const prompt = (opts.preamble ?? HARNESS_PREAMBLE) + taskPrompt;
  const model = opts.model || AGENT_MODEL;
  const effort = normalizeEffort(opts.reasoningEffort) ?? DEFAULT_REASONING_EFFORT;

  // Capture the agent's final message in a file OUTSIDE the clone so it can't pollute the diff.
  // CODEX_HOME is left at its default (~/.codex under HOME) — Codex refuses to create its helper
  // binaries when CODEX_HOME is under /tmp, and each Fargate task processes one job at a time.
  const outDir = await mkdtemp(join(tmpdir(), 'hermes-codex-'));
  const lastMsgFile = join(outDir, 'last.txt');

  const invocation = buildCodexExecInvocation({ dir, lastMsgFile, model, effort, prompt });

  const readFinalMessage = async (): Promise<string | undefined> => {
    try {
      const t = (await readFile(lastMsgFile, 'utf8')).trim();
      return t || undefined;
    } catch {
      return undefined;
    }
  };

  try {
    const env = { ...process.env, OPENAI_API_KEY: apiKey };
    await codexLogin(apiKey, env); // write ~/.codex/auth.json so `codex exec` can authenticate
    const { stdout, stderr, code, timedOut } = await runCodex(invocation.args, invocation.stdin, dir, env);
    if (timedOut) throw new AgentTimeoutError(JOB_TIMEOUT_MS / 1000);
    // Non-zero exit isn't necessarily fatal — surface the transcript; the caller decides based
    // on whether the working tree changed.
    const finalMessage = (await readFinalMessage()) ?? (stderr.trim() || undefined);
    const reason = finalMessage?.slice(0, 500);
    console.log(`[agent] codex exit ${code} (model=${model}, effort=${effort})`);
    return { transcript: `${stdout}\n${stderr}`.trim(), exitCode: code, reason, finalMessage };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
