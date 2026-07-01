/**
 * Coding engine: runs OpenAI Codex headless inside the cloned repo. We shell out to the `codex`
 * CLI (installed in the worker image) in non-interactive `codex exec` mode. The container is the
 * sandbox (ephemeral, isolated), so Codex runs with --dangerously-bypass-approvals-and-sandbox.
 * The model is pinned via AGENT_MODEL (default gpt-5.5). Hard timeout is the budget guardrail.
 */
import { spawn } from 'node:child_process';
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecretJson } from './secrets.js';

const SECRET_OPENAI = process.env.SECRET_OPENAI!;
const AGENT_MODEL = process.env.AGENT_MODEL || 'gpt-5.5';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;
const OUTPUT_CAP = 16 * 1024 * 1024;

export interface AgentResult {
  transcript: string;
  exitCode: number;
  /** The agent's final message — surfaced in Slack/Jira and used to explain a no-change run. */
  reason?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
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

// Run codex with stdin set to /dev/null. `codex exec` treats a piped/open stdin as appended
// input and blocks waiting for EOF — under execFile that pipe never closes, hanging the job.
function runCodex(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0, timedOut });
    });
  });
}

// Prepended to every task. The harness owns git: the agent edits files only, so change-detection
// and PR creation stay deterministic and the agent can't open a malformed/duplicate PR.
const HARNESS_PREAMBLE = `You are running inside an automated CI harness, on a fresh shallow clone of the repository, on a new branch that has already been created for you.

Git is handled FOR you — do NOT manage it yourself:
- Make the required code changes by EDITING FILES in the working directory only.
- Do NOT run \`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`, or any \`gh\` command, and do NOT open a pull request. The harness automatically commits your working-tree changes and opens the PR after you finish.
- Leave your edits uncommitted in the working tree and end your turn when the change is complete.

--- TASK ---

`;

export async function runAgent(dir: string, taskPrompt: string): Promise<AgentResult> {
  const { apiKey } = await getSecretJson(SECRET_OPENAI);
  if (!apiKey) throw new Error('OpenAI API key not configured in Secrets Manager');
  const prompt = HARNESS_PREAMBLE + taskPrompt;

  // Capture the agent's final message in a file OUTSIDE the clone so it can't pollute the diff.
  // CODEX_HOME is left at its default (~/.codex under HOME) — Codex refuses to create its helper
  // binaries when CODEX_HOME is under /tmp, and each Fargate task processes one job at a time.
  const outDir = await mkdtemp(join(tmpdir(), 'hermes-codex-'));
  const lastMsgFile = join(outDir, 'last.txt');

  const args = [
    'exec',
    '--model',
    AGENT_MODEL,
    '--dangerously-bypass-approvals-and-sandbox', // the Fargate container is the sandbox
    '--ephemeral', // don't persist session files
    '--skip-git-repo-check',
    '-C',
    dir,
    '-o',
    lastMsgFile,
    prompt,
  ];

  const readReason = async (): Promise<string | undefined> => {
    try {
      const t = (await readFile(lastMsgFile, 'utf8')).trim();
      return t ? t.slice(0, 500) : undefined;
    } catch {
      return undefined;
    }
  };

  try {
    const env = { ...process.env, OPENAI_API_KEY: apiKey };
    await codexLogin(apiKey, env); // write ~/.codex/auth.json so `codex exec` can authenticate
    const { stdout, stderr, code, timedOut } = await runCodex(args, dir, env);
    if (timedOut) throw new Error(`Agent timed out after ${JOB_TIMEOUT_MS / 1000}s`);
    // Non-zero exit isn't necessarily fatal — surface the transcript; the caller decides based
    // on whether the working tree changed.
    const reason = (await readReason()) ?? (stderr.trim().slice(0, 500) || undefined);
    console.log(`[agent] codex exit ${code}`);
    return { transcript: `${stdout}\n${stderr}`.trim(), exitCode: code, reason };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
