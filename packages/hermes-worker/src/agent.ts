/**
 * Coding engine: runs Claude Code headless inside the cloned repo. We shell out to the
 * `claude` CLI (installed globally in the worker image) rather than reimplementing an agent
 * loop. Budget guardrails (max iterations, hard timeout) are enforced here.
 */
import { execFile } from 'node:child_process';
import { getSecretString } from './secrets.js';

const SECRET_ANTHROPIC = process.env.SECRET_ANTHROPIC!;
const MAX_ITERATIONS = Number(process.env.MAX_AGENT_ITERATIONS ?? 40);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;

export interface AgentResult {
  transcript: string;
  exitCode: number;
}

/**
 * Run the agent against `dir` with `prompt`. Returns the captured transcript. The CLI applies
 * edits in-place; the caller commits whatever changed.
 */
export async function runAgent(dir: string, prompt: string): Promise<AgentResult> {
  const apiKey = await getSecretString(SECRET_ANTHROPIC);
  if (!apiKey) throw new Error('Anthropic API key not configured in Secrets Manager');

  return new Promise<AgentResult>((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', prompt, '--dangerously-skip-permissions', '--max-turns', String(MAX_ITERATIONS)],
      {
        cwd: dir,
        timeout: JOB_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      },
      (err, stdout, stderr) => {
        const transcript = `${stdout || ''}\n${stderr || ''}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          return reject(new Error(`Agent timed out after ${JOB_TIMEOUT_MS / 1000}s`));
        }
        // Non-zero exit is not necessarily fatal (the agent may finish with no edits);
        // surface the transcript and let the caller decide based on the diff.
        resolve({ transcript, exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
      }
    );
    child.on('error', reject);
  });
}
