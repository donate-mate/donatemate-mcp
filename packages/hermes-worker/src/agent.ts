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
const MAX_ITERATIONS = Number(process.env.MAX_AGENT_ITERATIONS ?? 40);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 2400) * 1000;

export interface AgentResult {
  transcript: string;
  exitCode: number;
}

export async function runAgent(dir: string, prompt: string): Promise<AgentResult> {
  const apiKey = await getSecretString(SECRET_ANTHROPIC);
  if (!apiKey) throw new Error('Anthropic API key not configured in Secrets Manager');

  const args = ['-p', prompt, '--dangerously-skip-permissions', '--max-turns', String(MAX_ITERATIONS)];

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
      return { transcript: `${stdout || ''}\n${stderr || ''}`.trim(), exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === 'ETIMEDOUT') throw new Error(`Agent timed out after ${JOB_TIMEOUT_MS / 1000}s`);
      // Non-zero exit isn't necessarily fatal — surface the transcript; the caller decides
      // based on whether the working tree changed.
      return {
        transcript: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  } finally {
    if (mcpDir) await rm(mcpDir, { recursive: true, force: true });
  }
}
