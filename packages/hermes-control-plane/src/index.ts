/**
 * Hermes Control Plane
 *
 * Always-on Fargate service behind the public ALB. Intake surface for the agentic-coding
 * platform: Slack (Events API, @mention + DM, conversational), Jira automation webhooks, and
 * a programmatic /dispatch endpoint (MCP / internal). Each task becomes a job row in DynamoDB
 * and is enqueued on SQS for the worker pool.
 *
 * Run: `tsx src/index.ts` (containerized). Listens on :3000; ALB health check hits /health.
 */
import Fastify, { type FastifyRequest } from 'fastify';
import { createJob, getJob, type WorkerType } from './jobs.js';
import { verifySlackSignature, postSlackMessage, stripMention } from './slack.js';
import { getSecretJson } from './secrets.js';
import { converse, conversationToTask, planIssue } from './converse.js';
import { appendMessage, getConversation, setActivePointer, getActivePointer } from './convo.js';
import { findIssueKey, fetchIssueContext, fetchIssue } from './jira.js';
import { getFlow, setFlow } from './jiraflow.js';
import { commentOnIssue, transitionIssue, COLUMN } from './jiraBot.js';

const PORT = Number(process.env.PORT ?? 3000);

// Default repo per worker type. FE = the Expo app; BE = the lambdas monorepo.
const REPO_BY_TYPE: Record<WorkerType, string> = {
  fe: 'donate-mate/donatemate-app',
  be: 'donate-mate/donatemate',
  qa: 'donate-mate/donatemate-app',
};

// Route a free-text Slack/Jira request to the right worker + repo. Backend signals
// ("backend", "back-end", "server-side", or an explicit "be:" prefix) → the lambdas repo;
// everything else defaults to the frontend app.
function routeIntent(text: string): { type: WorkerType; repo: string } {
  const t = (text || '').toLowerCase();
  const backend = /\bback[\s-]?end\b/.test(t) || /\bserver[\s-]?side\b/.test(t) || t.trimStart().startsWith('be:');
  const type: WorkerType = backend ? 'be' : 'fe';
  return { type, repo: REPO_BY_TYPE[type] };
}

// Route a Jira ticket to a repo using its structured signals (most reliable first): the
// frontend/backend labels, then the FE:/BE:/Frontend:/Backend: summary prefix, then a text
// fallback. `isDesign` flags Figma/design tickets that aren't coding tasks.
function routeIntentFromJira(summary: string, labels: string[]): { type: WorkerType; repo: string; isDesign: boolean } {
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  const s = (summary || '').toLowerCase();
  const isDesign = labelSet.has('design') || /^\s*design\s*:/.test(s);
  const backend =
    labelSet.has('backend') ||
    /^\s*(be|backend)\s*:/.test(s) ||
    (!labelSet.has('frontend') && routeIntent(summary).type === 'be');
  const type: WorkerType = backend ? 'be' : 'fe';
  return { type, repo: REPO_BY_TYPE[type], isDesign };
}

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

// Capture the raw JSON body (needed for Slack HMAC signature verification) while still
// parsing it for handlers.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

// Slack slash commands arrive form-encoded; capture raw body for signature verification.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  try {
    done(null, Object.fromEntries(new URLSearchParams((body as string) || '')));
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'hermes-control-plane' }));

// ---------------------------------------------------------------------------
// Slack Events API — @mention + DM, conversational (replies threaded)
// ---------------------------------------------------------------------------
app.post('/slack/events', async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // URL verification handshake (Slack sends this when you set the Request URL)
  if (body.type === 'url_verification') {
    return reply.send({ challenge: body.challenge });
  }

  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  if (!(await verifySlackSignature(raw, req.headers))) {
    return reply.code(401).send({ error: 'invalid signature' });
  }

  // Ack within Slack's 3s window, then process asynchronously.
  reply.send({ ok: true });
  handleSlackEvent(body).catch((err) => app.log.error({ err }, 'slack event handler failed'));
});

// Mention/DM → CONVERSE (gather requirements) and persist the dialog. No job is queued unless
// the user says /start (slash command, or inline in a message).
async function handleSlackEvent(body: Record<string, unknown>): Promise<void> {
  const event = body.event as
    | { type?: string; subtype?: string; text?: string; channel?: string; thread_ts?: string; ts?: string; user?: string; bot_id?: string }
    | undefined;
  if (!event || event.bot_id || event.subtype) return; // ignore our own / edited / system messages
  if (event.type !== 'app_mention' && event.type !== 'message') return;
  const { channel, user } = event;
  if (!channel || !user) return;

  const threadTs = event.thread_ts ?? event.ts;
  if (!threadTs) return;

  const text = stripMention(event.text ?? '').trim();
  if (!text) return;

  await setActivePointer(channel, user, threadTs);

  // Inline "/start" (or "start the job") → queue from the conversation so far.
  if (/(^|\s)\/start\b/i.test(text) || /\bstart the (job|task|coding)\b/i.test(text)) {
    const clean = text.replace(/\/start/gi, '').trim();
    if (clean) await appendMessage(channel, threadTs, { role: 'user', content: clean });
    await queueFromConversation(channel, user, threadTs);
    return;
  }

  await appendMessage(channel, threadTs, { role: 'user', content: text });
  const history = await getConversation(channel, threadTs);

  // If the conversation references a Jira issue, pull its context so Hermes can discuss it.
  const issueKey = findIssueKey(history.map((h) => h.content).join('\n'));
  const jiraContext = issueKey ? (await fetchIssueContext(issueKey)) ?? undefined : undefined;

  const reply = await converse(history, jiraContext);
  await appendMessage(channel, threadTs, { role: 'assistant', content: reply });
  await postSlackMessage(channel, reply, threadTs);
}

// Condense the stored conversation into a task and queue the coding job.
async function queueFromConversation(channel: string, user: string, threadTs: string): Promise<void> {
  const msgs = await getConversation(channel, threadTs);
  const transcript = msgs.map((m) => `${m.role === 'assistant' ? 'Hermes' : 'User'}: ${m.content}`).join('\n');
  if (!transcript) {
    await postSlackMessage(channel, ':information_source: Tell me what to build first, then run `/start`.', threadTs);
    return;
  }
  const taskPrompt = await conversationToTask(transcript);
  const { type, repo } = routeIntent(`${transcript}\n${taskPrompt}`);
  const job = await createJob({ type, repo, prompt: taskPrompt, source: 'slack', channel, threadTs, requestedBy: user });
  await postSlackMessage(
    channel,
    `:robot_face: Queued job \`${job.jobId}\` against \`${repo}\` from our conversation. I'll post the PR here when it's ready.`,
    threadTs
  );
}

// ---------------------------------------------------------------------------
// Slack slash command: /start — queue a coding job from the active conversation
// ---------------------------------------------------------------------------
app.post('/slack/commands', async (req, reply) => {
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  if (!(await verifySlackSignature(raw, req.headers))) {
    return reply.code(401).send('invalid signature');
  }
  const body = (req.body ?? {}) as Record<string, string>;
  // Ack within Slack's 3s window; summarize + queue asynchronously.
  reply.send({ response_type: 'ephemeral', text: ':hourglass_flowing_sand: Starting from our conversation…' });
  if ((body.command || '') === '/start') {
    handleStartCommand(body).catch((err) => app.log.error({ err }, '/start handler failed'));
  }
});

async function handleStartCommand(body: Record<string, string>): Promise<void> {
  const channel = body.channel_id;
  const user = body.user_id;
  if (!channel || !user) return;

  const threadTs = await getActivePointer(channel, user);
  if (!threadTs) {
    await postSlackMessage(channel, ':information_source: Mention me to discuss a task first, then run `/start`.');
    return;
  }
  await queueFromConversation(channel, user, threadTs);
}

// ---------------------------------------------------------------------------
// Jira automation webhook (shared-secret authenticated)
//
// Two-step, assignee-triggered flow driven by two Jira Automation rules:
//   phase "assigned" → Hermes derives a plan and comments it, awaiting confirmation.
//   phase "confirm"  → on a `/go` reply, Hermes queues the coding job and moves the ticket.
// Back-compat: a body carrying an explicit `prompt` queues a job directly (legacy/dispatch).
// ---------------------------------------------------------------------------
app.post('/jira/webhook', async (req, reply) => {
  const { sharedSecret } = await getSecretJson(process.env.SECRET_JIRA_WEBHOOK!);
  const provided = String(req.headers['x-hermes-secret'] ?? '');
  if (!sharedSecret || provided !== sharedSecret) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = (req.body ?? {}) as { prompt?: string; type?: WorkerType; issueKey?: string; phase?: string };

  // Legacy direct-prompt path.
  if (body.prompt && !body.issueKey) {
    const type = body.type ?? 'fe';
    const job = await createJob({ type, repo: REPO_BY_TYPE[type], prompt: body.prompt, source: 'jira' });
    return reply.send({ ok: true, jobId: job.jobId });
  }

  if (!body.issueKey) return reply.code(400).send({ error: 'issueKey or prompt required' });
  const issueKey = body.issueKey.toUpperCase();
  const phase = body.phase ?? 'assigned';

  // Ack fast (Jira Automation has its own timeout); plan/queue asynchronously.
  reply.send({ ok: true });
  const work = phase === 'confirm' ? handleJiraConfirm(issueKey) : handleJiraAssigned(issueKey);
  work.catch((err) => app.log.error({ err, issueKey, phase }, 'jira webhook handler failed'));
});

// Ticket assigned to Hermes → derive a plan, store it, and comment for confirmation. Does NOT
// run the agent yet. Idempotent: a re-assignment while running is a no-op.
async function handleJiraAssigned(issueKey: string): Promise<void> {
  const existing = await getFlow(issueKey);
  if (existing?.status === 'running') {
    await commentOnIssue(issueKey, `:robot_face: I'm already working on this (job \`${existing.jobId}\`).`);
    return;
  }

  const issue = await fetchIssue(issueKey);
  if (!issue) {
    await commentOnIssue(issueKey, ":warning: I couldn't read this ticket's details — check my Jira access.");
    return;
  }

  const { type, repo, isDesign } = routeIntentFromJira(issue.summary, issue.labels);
  if (isDesign) {
    await commentOnIssue(
      issueKey,
      ':information_source: This looks like a *design* ticket, not a coding task, so I won\'t pick it up. Unassign me if that was unintended, or reassign once there\'s a concrete code change to make.'
    );
    return;
  }

  const plan = await planIssue(issue.context);
  const taskPrompt = `Implement Jira issue ${issueKey}: ${issue.summary}\n\nPlanned approach:\n${plan}`;
  await setFlow(issueKey, { status: 'awaiting_confirm', taskPrompt, repo, type, plan });

  await commentOnIssue(
    issueKey,
    `:robot_face: *Hermes here.* I'll work this against \`${repo}\` (${type.toUpperCase()}).\n\n*Plan:*\n${plan}\n\nReply with \`/go\` to start, or refine the description and re-assign me to re-plan.`
  );
}

// `/go` confirmation → queue the job and advance the board.
async function handleJiraConfirm(issueKey: string): Promise<void> {
  const flow = await getFlow(issueKey);
  if (!flow) {
    await commentOnIssue(issueKey, ':information_source: Assign this ticket to me first, then reply `/go` to start.');
    return;
  }
  if (flow.status === 'running') {
    await commentOnIssue(issueKey, `:robot_face: Already on it — job \`${flow.jobId}\`.`);
    return;
  }

  const job = await createJob({
    type: flow.type,
    repo: flow.repo,
    prompt: flow.taskPrompt,
    source: `jira:${issueKey}`,
  });
  await setFlow(issueKey, { ...flow, status: 'running', jobId: job.jobId });
  await transitionIssue(issueKey, COLUMN.inProgress);
  await commentOnIssue(
    issueKey,
    `:hammer_and_wrench: Starting implementation — job \`${job.jobId}\` against \`${flow.repo}\`. I'll comment with the PR when it's ready.`
  );
}

// ---------------------------------------------------------------------------
// Programmatic dispatch (MCP / internal tools)
// ---------------------------------------------------------------------------
app.post('/dispatch', async (req, reply) => {
  const { sharedSecret } = await getSecretJson(process.env.SECRET_JIRA_WEBHOOK!);
  const provided = String(req.headers['x-hermes-secret'] ?? '');
  if (!sharedSecret || provided !== sharedSecret) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = (req.body ?? {}) as { prompt?: string; type?: WorkerType; repo?: string; baseBranch?: string };
  if (!body.prompt) return reply.code(400).send({ error: 'prompt required' });

  const type = body.type ?? 'fe';
  const job = await createJob({
    type,
    repo: body.repo ?? REPO_BY_TYPE[type],
    prompt: body.prompt,
    baseBranch: body.baseBranch,
    source: 'dispatch',
  });
  return reply.send({ ok: true, jobId: job.jobId });
});

app.get('/jobs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: 'not found' });
  return reply.send(job);
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`hermes-control-plane listening on ${addr}`))
  .catch((err) => {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  });
