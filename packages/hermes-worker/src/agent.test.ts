import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeExecInvocation,
  buildCodexExecInvocation,
  isProviderUnavailableOutput,
  parseClaudeOutput,
  runProcessWithTimeout,
} from './agent.js';

describe('buildCodexExecInvocation', () => {
  it('streams prompts larger than the OS argv limit through stdin', () => {
    const prompt = `Review this diff:\n${'x'.repeat(3 * 1024 * 1024)}`;

    const invocation = buildCodexExecInvocation({
      dir: '/tmp/repo',
      lastMsgFile: '/tmp/last.txt',
      model: 'gpt-5.5',
      effort: 'high',
      prompt,
    });

    expect(invocation.args.at(-1)).toBe('-');
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.args.join('').length).toBeLessThan(1024);
    expect(invocation.stdin).toBe(prompt);
  });

  it.skipIf(process.platform !== 'linux')(
    'settles promptly and terminates descendants that escape the process group',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hermes-agent-timeout-'));
      const marker = join(dir, 'escaped-child-survived');
      try {
        const escapedScript = [
          "const { writeFileSync } = require('node:fs');",
          `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 800);`,
          'setTimeout(() => {}, 1500);',
        ].join('\n');
        const childScript = [
          "const { spawn } = require('node:child_process');",
          // This descendant creates a different process group while retaining the command's pipes.
          `spawn(process.execPath, ['-e', ${JSON.stringify(escapedScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
          'setInterval(() => {}, 1000);',
        ].join('\n');
        const startedAt = Date.now();

        const result = await runProcessWithTimeout({
          command: process.execPath,
          args: ['-e', childScript],
          stdin: '',
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 250,
        });

        expect(result.timedOut).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await new Promise((resolve) => setTimeout(resolve, 900));
        await expect(access(marker)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('Anthropic provider failover', () => {
  it('streams the prompt to Claude Code without putting it on argv', () => {
    const prompt = 'repair this branch'.repeat(100_000);
    const invocation = buildClaudeExecInvocation({ model: 'claude-sonnet-5', prompt });

    expect(invocation.args).toContain('-p');
    expect(invocation.args).toContain('--dangerously-skip-permissions');
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.stdin).toBe(prompt);
  });

  it('parses the structured Claude Code final result', () => {
    expect(
      parseClaudeOutput(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixed' }),
        ''
      )
    ).toEqual({ finalMessage: 'fixed', isError: false });
  });

  it.each([
    'credit_balance_exhausted',
    'You have no credits remaining.',
    'insufficient_quota',
    'API Error: 529 overloaded_error',
  ])('classifies provider capacity failures: %s', (message) => {
    expect(isProviderUnavailableOutput(message)).toBe(true);
  });
});
