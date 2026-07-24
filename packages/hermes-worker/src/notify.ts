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

export async function postSlackChannelMessage(channel: string, text: string): Promise<boolean> {
  const secretName = process.env.SECRET_SLACK;
  if (!secretName || !channel.trim()) return false;
  const { botToken } = await getSecretJson(secretName);
  if (!botToken) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel.trim(), text, mrkdwn: true, link_names: true, unfurl_links: false }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) {
      console.warn(`[slack] QA notification to ${channel} failed: ${body.error ?? 'unknown error'}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[slack] QA notification to ${channel} errored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function lookupSlackUserMentionByEmail(email: string): Promise<string | null> {
  const secretName = process.env.SECRET_SLACK;
  const normalizedEmail = email.trim();
  if (!secretName || !normalizedEmail) return null;
  try {
    const { botToken } = await getSecretJson(secretName);
    if (!botToken) return null;
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(normalizedEmail)}`, {
      headers: { Authorization: `Bearer ${botToken}`, Accept: 'application/json' },
    });
    const body = (await res.json()) as { ok?: boolean; error?: string; user?: { id?: string } };
    if (body.ok && body.user?.id) return `<@${body.user.id}>`;
    console.warn(`[slack] user lookup for ${normalizedEmail} failed: ${body.error ?? 'unknown error'}`);
  } catch (err) {
    console.warn(`[slack] user lookup for ${normalizedEmail} errored: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}
