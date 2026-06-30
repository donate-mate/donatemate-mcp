/**
 * Coding engine: runs Claude Code headless inside the cloned repo. We shell out to the
 * `claude` CLI (installed in the worker image). The DonateMate MCP (dm_jira_*, dm_confluence_*,
 * dm_figma_*, dm_knowledge_*, …) is attached so the agent can read/write Jira and leverage the
 * rest of the platform's tools. Budget guardrails (max iterations, hard timeout) enforced here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSecretString, getSecretJson } from './secrets.js';

const pexec = promisify(execFile);

const SECRET_ANTHROPIC = process.env.SECRET_ANTHROPIC!;
const SECRET_DM_MCP = process.env.SECRET_DM_MCP;
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || 'https://mcp.donate-mate.com/mcp';
// Turns must cover EXPLORE (grep/read/MCP, one turn each) + EDIT. 40 starved exploration on a
// large RN/Expo repo and the agent never reached the edit phase. The token budget and the hard
// timeout are the real guardrails; keep turns high enough that they bind first.
const MAX_ITERATIONS = Number(process.env.MAX_AGENT_ITERATIONS ?? 200);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;

export interface AgentResult {
  transcript: string;
  exitCode: number;
  /** Concise outcome for surfacing in Slack/Jira (e.g. "hit the 200-turn limit"). */
  reason?: string;
}

// Parse `claude --output-format json` result envelope into a human-readable reason.
function summarize(stdout: string): { reason?: string; numTurns?: number } {
  try {
    const j = JSON.parse(stdout) as {
      subtype?: string;
      is_error?: boolean;
      num_turns?: number;
      result?: string;
    };
    const numTurns = j.num_turns;
    if (j.subtype === 'error_max_turns') return { reason: `hit the ${MAX_ITERATIONS}-turn limit before finishing`, numTurns };
    if (j.is_error) return { reason: (j.result || j.subtype || 'agent reported an error').slice(0, 300), numTurns };
    return { reason: j.result ? j.result.slice(0, 300) : undefined, numTurns };
  } catch {
    return {};
  }
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
  const apiKey = await getSecretString(SECRET_ANTHROPIC);
  if (!apiKey) throw new Error('Anthropic API key not configured in Secrets Manager');
  const prompt = HARNESS_PREAMBLE + taskPrompt;

  // JSON output so we always capture the outcome (num_turns, error subtype, final result) even
  // when the run errors — text output yields nothing on a max-turns exit.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--max-turns',
    String(MAX_ITERATIONS),
  ];

  // Attach the DonateMate MCP. The config (with the API key) is written OUTSIDE the repo clone
  // so the credential can never be committed by the agent.
  let mcpDir: string | null = null;
  try {
    if (SECRET_DM_MCP) {
      const { apiKey: dmKey } = await getSecretJson(SECRET_DM_MCP);
      if (dmKey) {
        mcpDir = await mkdtemp(join(tmpdir(), 'hermes-mcp-'));
        const cfgPath = join(mcpDir, 'mcp.json');
        await writeFile(
          cfgPath,
          JSON.stringify({
            mcpServers: {
              donatemate: { type: 'http', url: MCP_ENDPOINT, headers: { Authorization: `Bearer ${dmKey}` } },
            },
          })
        );
        args.push(
          '--mcp-config',
          cfgPath,
          '--strict-mcp-config',
          // prevent the agent from recursively dispatching Hermes jobs
          '--disallowedTools',
          'mcp__donatemate__dm_hermes_create_pr',
          'mcp__donatemate__dm_hermes_job_status'
        );
      }
    }

    try {
      const { stdout, stderr } = await pexec('claude', args, {
        cwd: dir,
        timeout: JOB_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      });
      const { reason, numTurns } = summarize(stdout || '');
      console.log(`[agent] completed in ${numTurns ?? '?'} turns`);
      return { transcript: `${stdout || ''}\n${stderr || ''}`.trim(), exitCode: 0, reason };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ETIMEDOUT') throw new Error(`Agent timed out after ${JOB_TIMEOUT_MS / 1000}s`);
      // Non-zero exit isn't necessarily fatal — surface the transcript; the caller decides
      // based on whether the working tree changed.
      const { reason, numTurns } = summarize(e.stdout || '');
      console.log(`[agent] non-zero exit after ${numTurns ?? '?'} turns: ${reason ?? e.stderr ?? ''}`);
      return {
        transcript: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        exitCode: typeof e.code === 'number' ? e.code : 1,
        reason: reason ?? ((e.stderr || '').trim().slice(0, 300) || undefined),
      };
    }
  } finally {
    if (mcpDir) await rm(mcpDir, { recursive: true, force: true });
  }
}
