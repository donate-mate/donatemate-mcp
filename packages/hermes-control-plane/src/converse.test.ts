import { describe, expect, it } from 'vitest';
import { isOpenAiUnavailableError } from './converse.js';

describe('conversational provider failover', () => {
  it.each([
    { status: 429, message: 'rate limited' },
    { status: 503, message: 'unavailable' },
    new Error('credit_balance_exhausted: You have no credits remaining'),
  ])('classifies an unavailable primary provider', (error) => {
    expect(isOpenAiUnavailableError(error)).toBe(true);
  });

  it('does not hide an ordinary request bug', () => {
    expect(isOpenAiUnavailableError({ status: 400, message: 'bad request' })).toBe(false);
  });
});
