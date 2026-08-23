import { describe, expect, it } from 'vitest';
import {
  PROVIDER_BILLING_BLOCKED_LABEL,
  providerBillingBlockedComment,
  providerBillingRecoveredComment,
} from './providerBilling.js';

describe('provider billing Jira state', () => {
  it('uses a stable searchable Jira label', () => {
    expect(PROVIDER_BILLING_BLOCKED_LABEL).toBe('hermes-provider-billing-blocked');
  });

  it('explains that the exact job is preserved and will restart automatically', () => {
    const comment = providerBillingBlockedComment({
      jobId: 'job-123',
      providers: ['openai'],
      retryAfterSeconds: 300,
    });

    expect(comment).toContain('model-provider billing');
    expect(comment).toContain('OpenAI');
    expect(comment).toContain('`job-123`');
    expect(comment).toContain('has **not** been failed or moved back to To Do');
    expect(comment).toContain('retry automatically in 5 minutes');
    expect(comment).toContain('No reassignment or new `/go` comment is required');
  });

  it('reports the provider that accepted the automatic recovery request', () => {
    const comment = providerBillingRecoveredComment({ jobId: 'job-123', provider: 'anthropic' });

    expect(comment).toContain('resumed automatically');
    expect(comment).toContain('Anthropic');
    expect(comment).toContain('`job-123`');
    expect(comment).toContain('removed the billing-blocked flag');
  });
});
