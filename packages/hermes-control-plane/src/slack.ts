/**
 * Slack glue: verify inbound request signatures (Events API) and post replies.
 * Tolerates unconfigured credentials (returns false / no-op) so the service runs
 * before the Slack app secret is populated.
 */
import crypto from 'node:crypto';
import { getSecretJson } from './secrets.js';

const SECRET_SLACK = process.env.SECRET_SLACK!;

export async function verifySlackSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<boolean> {
  const { signingSecret } = await getSecretJson(SECRET_SLACK);
  if (!signingSecret) return false;

  const ts = String(headers['x-slack-request-timestamp'] ?? '');
  const sig = String(headers['x-slack-signature'] ?? '');
  if (!ts || !sig) return false;
  // reject stale requests (>5 min) to prevent replay
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;

  const base = `v0:${ts}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export async function postSlackMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  const { botToken } = await getSecretJson(SECRET_SLACK);
  if (!botToken) return; // not configured yet
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}

/** Strip a leading bot @mention (e.g. "<@U123> do the thing" → "do the thing"). */
export function stripMention(text: string): string {
  return (text || '').replace(/<@[^>]+>\s*/g, '').trim();
}

let botUserId: string | null = null;
export async function getBotUserId(): Promise<string | null> {
  if (botUserId) return botUserId;
  const { botToken } = await getSecretJson(SECRET_SLACK);
  if (!botToken) return null;
  const r = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const j = (await r.json()) as { user_id?: string };
  botUserId = j.user_id ?? null;
  return botUserId;
}

export interface SlackThreadMsg {
  user?: string;
  bot_id?: string;
  text: string;
}

/** Fetch a thread's messages (oldest→newest) via conversations.replies. */
export async function getThreadReplies(channel: string, threadTs: string): Promise<SlackThreadMsg[]> {
  const { botToken } = await getSecretJson(SECRET_SLACK);
  if (!botToken) return [];
  const r = await fetch(
    `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=50`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const j = (await r.json()) as { messages?: SlackThreadMsg[] };
  return (j.messages ?? []).map((m) => ({ user: m.user, bot_id: m.bot_id, text: stripMention(m.text ?? '') }));
}
