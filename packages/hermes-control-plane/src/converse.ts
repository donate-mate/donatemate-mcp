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

Format: 3-6 concise bullet points covering your understanding of the defect/feature, where in the codebase you expect to make changes, and the approach. If anything is ambiguous or risky, call it out. Do NOT write code. Keep it tight — this is a Jira comment, not an essay.

For backend defects, production/staging alerts, alarms, or canary failures: assume AWS CLI observability access is available. The plan must explicitly verify evidence first: CloudWatch alarm history/metrics, Synthetics runs/artifacts, relevant CloudWatch Logs, deploy/e2e timing, and whether real traffic was impacted. It must classify the alarm as a false positive, too sensitive/misconfigured, or a real source defect before proposing the fix. Do not ask whether AWS access exists.`;

/** Produce a short, reviewer-facing implementation plan from a Jira issue's context. */
export async function planIssue(issueContext: string): Promise<string> {
  const plan = await complete(PLAN_SYSTEM, [{ role: 'user', content: issueContext }], 1024);
  return plan || 'I will investigate the codebase and implement the change described in this ticket.';
}

// --- WS5 --- Derive an acceptance/defect checklist from a Jira ticket for readiness gating.
const CHECKLIST_SYSTEM = `You extract a verification checklist from a DonateMate Jira ticket for an autonomous coding agent's PR.

From the ticket description AND its comments, list the independently-observable defect fixes and acceptance criteria that a reviewer could each verify on their own. Each item must be a short, concrete, checkable statement (no vague "works correctly").

Output ONLY a JSON array of strings. No prose, no markdown fences. If there are no observable items, output [].`;

// --- WS5 --- Parse a JSON array of strings defensively, tolerating code fences / surrounding prose.
function parseJsonStringArray(raw: string): string[] {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// --- WS5 --- LLM pass returning a checklist of observable items from the ticket context.
export async function extractChecklist(issueContext: string): Promise<string[]> {
  try {
    const raw = await complete(CHECKLIST_SYSTEM, [{ role: 'user', content: issueContext }], 1024);
    return parseJsonStringArray(raw);
  } catch {
    return [];
  }
}

const QA_SCENARIO_SYSTEM = `You draft DonateMate QA scenarios for Confluence using the locked scenario template.

Rules:
- Output exactly one scenario in markdown.
- Use the supplied scenario ID exactly.
- Use observable UI behavior only.
- Reference test data by TD-* ID when known; do not invent credentials.
- Include Priority, Platforms, Related tickets, Given/When/Then steps, Edge variants if relevant, and Out of scope if relevant.
- If the ticket is backend-only, infra-only, a spike, or has no user-facing behavior, output exactly: N/A
- Do not claim behavior that is currently broken or defect-held.`;

export async function draftQaScenario(issueContext: string, scenarioId: string, pageTitle: string): Promise<string> {
  const prompt = [
    `Scenario ID: ${scenarioId}`,
    `Target Confluence page: ${pageTitle}`,
    '',
    'Jira context:',
    issueContext,
  ].join('\n');
  return complete(QA_SCENARIO_SYSTEM, [{ role: 'user', content: prompt }], 1600);
}
