/**
 * Conversational layer — Hermes talks with the developer to gather a coding task before any
 * code is written, and (on /start) condenses the whole conversation into a single task spec for
 * the worker. Uses the Anthropic API. Sonnet for snappy Slack latency (override CONVERSE_MODEL).
 */
import Anthropic from '@anthropic-ai/sdk';
import { getSecretString } from './secrets.js';

const SECRET_ANTHROPIC = process.env.SECRET_ANTHROPIC!;
const MODEL = process.env.CONVERSE_MODEL || 'claude-sonnet-4-6';

let client: Anthropic | null = null;
async function getClient(): Promise<Anthropic> {
  if (client) return client;
  const apiKey = await getSecretString(SECRET_ANTHROPIC);
  if (!apiKey) throw new Error('Anthropic API key not configured');
  client = new Anthropic({ apiKey });
  return client;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const CHAT_SYSTEM = `You are Hermes, DonateMate's self-hosted coding agent, chatting with a developer in Slack to scope a coding task BEFORE any code is written.

Your job here is to understand the task: ask brief, specific clarifying questions, confirm which repo (frontend "donatemate-app" vs backend "donatemate"), the concrete change, and acceptance criteria. Reference any Jira issue keys (DM-###) the user mentions.

Rules:
- Keep replies short and Slack-friendly (a few lines, no walls of text).
- Do NOT write code or open a PR here — you are only gathering requirements.
- When you have enough to implement it, say so and tell the user to run \`/start\` to queue the coding job.`;

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Generate Hermes's next conversational reply. If a referenced Jira issue's context is
 * supplied, it's injected so Hermes can discuss the actual ticket. */
export async function converse(history: ChatMsg[], jiraContext?: string): Promise<string> {
  const c = await getClient();
  const system = jiraContext
    ? `${CHAT_SYSTEM}\n\nThe user referenced a Jira issue — here is its current content. Use it to discuss the task knowledgeably (you DO have its details below; don't claim you can't access Jira):\n\n${jiraContext}`
    : CHAT_SYSTEM;
  const message = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: history.length ? history : [{ role: 'user', content: 'Hi' }],
  });
  return textOf(message) || "Got it — tell me a bit more and run `/start` when you're ready.";
}

const TASK_SYSTEM = `Convert the following Slack conversation between a developer and Hermes (a coding agent) into a single, self-contained task instruction for an autonomous coding agent that will implement it. The agent runs in a harness that handles git and opens the PR automatically, so describe the CODE CHANGE only — do NOT instruct it to commit, push, or open a pull request.

Output ONLY the task instruction — no preamble, no questions. Include: the concrete change to make, the repo if stated, any acceptance criteria discussed, and any Jira issue keys (DM-###) referenced. Be specific and actionable.`;

/** Condense the conversation into a concrete coding-task prompt for the worker. */
export async function conversationToTask(transcript: string): Promise<string> {
  const c = await getClient();
  const message = await c.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: TASK_SYSTEM,
    messages: [{ role: 'user', content: transcript }],
  });
  return textOf(message);
}

const PLAN_SYSTEM = `You are Hermes, DonateMate's coding agent. You've been assigned a Jira ticket. Read its content and write a SHORT implementation plan for a human reviewer to approve before you start coding.

Format: 3-6 concise bullet points covering your understanding of the defect/feature, where in the codebase you expect to make changes, and the approach. If anything is ambiguous or risky, call it out. Do NOT write code. Keep it tight — this is a Jira comment, not an essay.`;

/** Produce a short, reviewer-facing implementation plan from a Jira issue's context. */
export async function planIssue(issueContext: string): Promise<string> {
  const c = await getClient();
  const message = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: issueContext }],
  });
  return textOf(message) || 'I will investigate the codebase and implement the change described in this ticket.';
}
