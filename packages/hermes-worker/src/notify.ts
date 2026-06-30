/**
 * Close the loop: post job results back to Slack (threaded) and/or Jira. Both are best-effort
 * and tolerate unconfigured credentials.
 */
import { getSecretJson } from './secrets.js';
import type { HermesJob } from './jobs.js';

export async function notify(job: HermesJob, text: string): Promise<void> {
  await Promise.allSettled([notifySlack(job, text), notifyJira(job, text)]);
}

async function notifySlack(job: HermesJob, text: string): Promise<void> {
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

async function notifyJira(job: HermesJob, text: string): Promise<void> {
  if (!job.source?.startsWith('jira:')) return;
  const secretName = process.env.SECRET_JIRA;
  if (!secretName) return;
  const { host, email, token } = await getSecretJson(secretName);
  if (!host || !email || !token) return;
  const issueKey = job.source.slice('jira:'.length);
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  await fetch(`${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    }),
  });
}
