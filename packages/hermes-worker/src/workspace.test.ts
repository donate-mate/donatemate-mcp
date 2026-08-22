import { describe, expect, it } from 'vitest';
import { runWorkspaceCommand } from './workspace.js';

describe('workspace dependency timeout', () => {
  it('returns a degraded timeout instead of throwing a worker-restart error', async () => {
    const result = await runWorkspaceCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      {},
      100
    );

    expect(result).toMatchObject({ code: 124, timedOut: true });
  });
});
