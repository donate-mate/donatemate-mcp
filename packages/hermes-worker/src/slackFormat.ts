const JIRA_BASE_URL = (process.env.JIRA_BROWSE_BASE_URL || process.env.JIRA_BASE_URL || 'https://donatemate.atlassian.net').replace(
  /\/+$/,
  ''
);

export function slackLink(url: string, label: string): string {
  return `<${url}|${label}>`;
}

export function jiraIssueSlackLink(issueKey: string): string {
  return slackLink(`${JIRA_BASE_URL}/browse/${encodeURIComponent(issueKey)}`, issueKey);
}

export function slackUserMention(value: string | undefined, fallbackName: string): string {
  const trimmed = (value || '').trim();
  if (/^<@[UW][A-Z0-9]+>$/.test(trimmed)) return trimmed;
  if (/^[UW][A-Z0-9]+$/.test(trimmed)) return `<@${trimmed}>`;
  if (trimmed.startsWith('@')) {
    console.warn(`[slack] QA_SLACK_MENTION must be a Slack user ID token like <@U123>; got ${trimmed}`);
  }
  return fallbackName;
}

export function configuredSlackUserMention(value: string | undefined): string | null {
  const trimmed = (value || '').trim();
  if (/^<@[UW][A-Z0-9]+>$/.test(trimmed)) return trimmed;
  if (/^[UW][A-Z0-9]+$/.test(trimmed)) return `<@${trimmed}>`;
  if (trimmed.startsWith('@')) {
    console.warn(`[slack] QA_SLACK_MENTION must be a Slack user ID token like <@U123>; got ${trimmed}`);
  }
  return null;
}
