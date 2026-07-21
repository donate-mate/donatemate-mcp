import { describe, expect, it } from 'vitest';
import { buildCodexExecInvocation } from './agent.js';

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
});
