/** Prompt guidance for the tightly scoped, IAM-only staging database investigation gateway. */
export function stagingDatabasePromptBlock(workerType: string | undefined, issueKey?: string): string {
  const functionName = process.env.HERMES_STAGING_DB_QUERY_FUNCTION?.trim();
  if (workerType !== 'be' || !functionName) return '';
  const ticket = issueKey && /^[A-Z][A-Z0-9]+-\d+$/.test(issueKey) ? issueKey : 'DM-####';
  return [
    '--- STAGING DATABASE INVESTIGATION (READ ONLY) ---',
    'For backend investigation only, you may query the staging PostgreSQL database through the dedicated IAM-only query Lambda.',
    'The Lambda and its database login both enforce read-only access, a 10-second statement timeout, and a 200-row hard cap.',
    'Use it only when live staging evidence is relevant. Never treat staging data as production evidence and never attempt to access production.',
    'Select the fewest columns and rows needed. Avoid secrets, tokens, full donor PII, or broad table dumps; redact sensitive values from transcripts, PRs, and Jira.',
    '',
    'Example (use PostgreSQL $1 parameters for values):',
    '```bash',
    `aws lambda invoke --function-name ${functionName} --cli-binary-format raw-in-base64-out --payload '{"sql":"SELECT id, status FROM donations WHERE id = $1","parameters":["record-id"],"maxRows":20,"ticket":"${ticket}"}' /tmp/hermes-staging-db.json >/dev/null`,
    'cat /tmp/hermes-staging-db.json',
    '```',
    'For schema discovery, query information_schema.columns with a narrow table_schema/table_name filter.',
  ].join('\n');
}
