import { afterEach, describe, expect, it } from 'vitest';
import { stagingDatabasePromptBlock } from './stagingDatabase.js';

const originalFunctionName = process.env.HERMES_STAGING_DB_QUERY_FUNCTION;

afterEach(() => {
  if (originalFunctionName === undefined) delete process.env.HERMES_STAGING_DB_QUERY_FUNCTION;
  else process.env.HERMES_STAGING_DB_QUERY_FUNCTION = originalFunctionName;
});

describe('stagingDatabasePromptBlock', () => {
  it('only advertises the gateway to backend work', () => {
    process.env.HERMES_STAGING_DB_QUERY_FUNCTION = 'donatemate-staging-hermes-db-query';
    expect(stagingDatabasePromptBlock('fe', 'DM-1567')).toBe('');
    expect(stagingDatabasePromptBlock('be', 'DM-1567')).toContain('donatemate-staging-hermes-db-query');
  });

  it('uses the ticket as audit metadata and AWS CLI v2 payload mode', () => {
    process.env.HERMES_STAGING_DB_QUERY_FUNCTION = 'donatemate-staging-hermes-db-query';
    const prompt = stagingDatabasePromptBlock('be', 'DM-1567');
    expect(prompt).toContain('--cli-binary-format raw-in-base64-out');
    expect(prompt).toContain('"ticket":"DM-1567"');
    expect(prompt).toContain('READ ONLY');
  });
});
