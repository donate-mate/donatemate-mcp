/**
 * Conversational layer — Hermes talks with the developer to gather a coding task before any
 * code is written, condenses a conversation into a single task spec, and drafts plans for Jira
 * tickets. Uses the OpenAI API. Model pinned via CONVERSE_MODEL (default gpt-5.3-chat-latest).
 */
import OpenAI from 'openai';
import { getSecretJson } from './secrets.js';

const SECRET_OPENAI = process.env.SECRET_OPENAI!;
const MODEL = process.env.CONVERSE_MODEL || 'gpt-5.3-chat-latest';

let client: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (client) return client;
  const { apiKey } = await getSecretJson(SECRET_OPENAI);
  if (!apiKey) throw new Error('OpenAI API key not configured');
  client = new OpenAI({ apiKey });
  return client;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

// `startCommand` differs by surface: `/start` in Slack, `/go` in Jira comments.
function chatSystem(startCommand: string): string {
  return `You are Hermes, DonateMate's self-hosted coding agent, scoping a coding task with a developer BEFORE any code is written.

Your job here is to understand the task: ask brief, specific clarifying questions, confirm which repo (frontend "donatemate-app" vs backend "donatemate"), the concrete change, and acceptance criteria. Reference any Jira issue keys (DM-###) the user mentions.

Rules:
- Keep replies short and to the point (a few lines, no walls of text).
- Do NOT write code or open a PR here — you are only gathering requirements.
- When you have enough to implement it, say so and tell the user to reply \`${startCommand}\` to queue the coding job.`;
}

/** One chat completion → trimmed text. */
async function complete(system: string, messages: ChatMsg[], maxTokens: number): Promise<string> {
  const c = await getClient();
  const res = await c.chat.completions.create({
    model: MODEL,
    max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  });
  return (res.choices[0]?.message?.content ?? '').trim();
}

export interface ConverseOpts {
  jiraContext?: string;
  /** The confirm keyword to tell the user about (`/start` for Slack, `/go` for Jira). */
  startCommand?: string;
}

/** Generate Hermes's next conversational reply. If a referenced Jira issue's context is
 * supplied, it's injected so Hermes can discuss the actual ticket. */
export async function converse(history: ChatMsg[], opts: ConverseOpts = {}): Promise<string> {
  const startCommand = opts.startCommand ?? '/start';
  const base = chatSystem(startCommand);
  const system = opts.jiraContext
    ? `${base}\n\nThe user referenced a Jira issue — here is its current content. Use it to discuss the task knowledgeably (you DO have its details below; don't claim you can't access Jira):\n\n${opts.jiraContext}`
    : base;
  const text = await complete(system, history.length ? history : [{ role: 'user', content: 'Hi' }], 1024);
  return text || `Got it — tell me a bit more and reply \`${startCommand}\` when you're ready.`;
}

const TASK_SYSTEM = `Convert the following conversation between a developer and Hermes (a coding agent) into a single, self-contained task instruction for an autonomous coding agent that will implement it. The agent runs in a harness that handles git and opens the PR automatically, so describe the CODE CHANGE only — do NOT instruct it to commit, push, or open a pull request.

Output ONLY the task instruction — no preamble, no questions. Include: the concrete change to make, the repo if stated, any acceptance criteria discussed, and any Jira issue keys (DM-###) referenced. Be specific and actionable.`;

/** Condense the conversation into a concrete coding-task prompt for the worker. */
export async function conversationToTask(transcript: string): Promise<string> {
  return complete(TASK_SYSTEM, [{ role: 'user', content: transcript }], 2048);
}

const PLAN_SYSTEM = `You are Hermes, DonateMate's coding agent. You've been assigned a Jira ticket. Read its content and write a SHORT implementation plan for a human reviewer to approve before you start coding.

Format: 3-6 concise bullet points covering your understanding of the defect/feature, where in the codebase you expect to make changes, and the approach. If anything is ambiguous or risky, call it out. Do NOT write code. Keep it tight — this is a Jira comment, not an essay.`;

/** Produce a short, reviewer-facing implementation plan from a Jira issue's context. */
export async function planIssue(issueContext: string): Promise<string> {
  const plan = await complete(PLAN_SYSTEM, [{ role: 'user', content: issueContext }], 1024);
  return plan || 'I will investigate the codebase and implement the change described in this ticket.';
}
