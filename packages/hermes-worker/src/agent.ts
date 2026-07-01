/**
 * Coding engine: runs OpenAI Codex headless inside the cloned repo. We shell out to the `codex`
 * CLI (installed in the worker image) in non-interactive `codex exec` mode. The container is the
 * sandbox (ephemeral, isolated), so Codex runs with --dangerously-bypass-approvals-and-sandbox.
 * The model is pinned via AGENT_MODEL (default gpt-5.5). Hard timeout is the budget guardrail.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecretJson } from './secrets.js';

const pexec = promisify(execFile);

const SECRET_OPENAI = process.env.SECRET_OPENAI!;
const AGENT_MODEL = process.env.AGENT_MODEL || 'gpt-5.5';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;

export interface AgentResult {
  transcript: string;
  exitCode: number;
  /** The agent's final message — surfaced in Slack/Jira and used to explain a no-change run. */
  reason?: string;
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
    try {
      const { stdout, stderr } = await pexec('codex', args, {
        cwd: dir,
        timeout: JOB_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, OPENAI_API_KEY: apiKey },
      });
      const reason = await readReason();
      console.log('[agent] codex run completed');
      return { transcript: `${stdout || ''}\n${stderr || ''}`.trim(), exitCode: 0, reason };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ETIMEDOUT') throw new Error(`Agent timed out after ${JOB_TIMEOUT_MS / 1000}s`);
      // Non-zero exit isn't necessarily fatal — surface the transcript; the caller decides based
      // on whether the working tree changed.
      const reason = (await readReason()) ?? ((e.stderr || '').trim().slice(0, 500) || undefined);
      console.log(`[agent] codex non-zero exit: ${reason ?? ''}`);
      return {
        transcript: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        exitCode: typeof e.code === 'number' ? e.code : 1,
        reason,
      };
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
