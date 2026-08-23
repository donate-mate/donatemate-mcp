import type { AgentProvider } from './agent.js';

export const PROVIDER_BILLING_BLOCKED_LABEL = 'hermes-provider-billing-blocked';

function providerList(providers: AgentProvider[]): string {
  const names = [...new Set(providers)].map((provider) => (provider === 'openai' ? 'OpenAI' : 'Anthropic'));
  return names.length ? names.join(' and ') : 'the configured model provider';
}

function retryText(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}

export function providerBillingBlockedComment(input: {
  jobId: string;
  providers: AgentProvider[];
  retryAfterSeconds: number;
}): string {
  return [
    '⏸️ **Hermes paused: model-provider billing**',
    '',
    `${providerList(input.providers)} reported exhausted credits, quota, or a billing hard limit while running job \`${input.jobId}\`.`,
    '',
    `The job is preserved and has **not** been failed or moved back to To Do. Hermes will retry automatically in ${retryText(input.retryAfterSeconds)} and continue from the ticket/PR workflow when a configured provider accepts requests again. No reassignment or new \`/go\` comment is required.`,
  ].join('\n');
}

export function providerBillingRecoveredComment(input: { jobId: string; provider: AgentProvider }): string {
  const provider = input.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  return [
    '▶️ **Hermes resumed automatically**',
    '',
    `Model-provider access is available again through ${provider}. Hermes restarted preserved job \`${input.jobId}\` and removed the billing-blocked flag.`,
  ].join('\n');
}
