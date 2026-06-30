/**
 * Slack notifications for job results (threaded). Best-effort; tolerates unconfigured creds.
 * Jira write-back (progress comments + column moves) is handled separately in jiraBot.ts so it
 * can post as the Hermes account and advance the board.
 */
import { getSecretJson } from './secrets.js';
import type { HermesJob } from './jobs.js';

export async function notify(job: HermesJob, text: string): Promise<void> {
  const secretName = process.env.SECRET_SLACK;
  if (!secretName || !job.channel) return;
  const { botToken } = await getSecretJson(secretName);
  if (!botToken) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: job.channel, text, thread_ts: job.threadTs }),
  });
}
