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
import { converse, conversationToTask, planIssue, extractChecklist } from './converse.js';
import { appendMessage, getConversation, resetConversation, setActivePointer, getActivePointer } from './convo.js';
import {
  findIssueKey,
  fetchIssueContext,
  fetchIssue,
  fetchLatestHermesAssignmentEvent,
  fetchRecentHermesAssignmentEvents,
  type JiraIssue,
} from './jira.js';
import { getFlow, setFlow, type JiraFlow } from './jiraflow.js';
import { commentOnIssue, transitionIssue, getBotAccountId, COLUMN } from './jiraBot.js';
import { handleGitHubWebhook, reconcileOpenPrs } from './prMonitor.js';
import { captureQaScenarioForDone } from './qaCapture.js';
import {
  completeJiraAssignmentClaim,
  releaseJiraAssignmentClaim,
  tryClaimJiraAssignment,
} from './jiraAssignmentClaims.js';
import { processJiraAssignmentEvent, reconcileJiraAssignmentEvents } from './jiraAssignmentReconciler.js';

const PORT = Number(process.env.PORT ?? 3000);
const PR_RECONCILE_SECONDS = Number(process.env.PR_RECONCILE_SECONDS ?? 300);
const JIRA_ASSIGNMENT_RECONCILE_SECONDS = Number(process.env.JIRA_ASSIGNMENT_RECONCILE_SECONDS ?? 300);
const JIRA_ASSIGNMENT_LOOKBACK_DAYS = Number(process.env.JIRA_ASSIGNMENT_LOOKBACK_DAYS ?? 7);
// --- WS5 --- Ticket-checklist extraction gate (default on; fail-open).
const CHECKLIST_ENABLED = !/^(0|false|no|off)$/i.test(process.env.CHECKLIST_ENABLED ?? 'true');

// Default repo per worker type. FE = the Expo app; BE = the lambdas monorepo.
const REPO_BY_TYPE: Record<WorkerType, string> = {
  fe: 'donate-mate/donatemate-app',
  be: 'donate-mate/donatemate',
  qa: 'donate-mate/donatemate-app',
};

function hasBackendTextSignal(text: string): boolean {
  const t = (text || '').toLowerCase();
  return (
    /\bback[\s-]?end\b/.test(t) ||
    /\bserver[\s-]?side\b/.test(t) ||
    /\binfra(structure)?\b/.test(t) ||
    /\b(api gateway|lambda|step function|cloudwatch|synthetics?|canary|alarm|datastore|dynamodb|sqs|sns|eventbridge|opensearch)\b/.test(t) ||
    /\b(prod|production|staging)\b.{0,80}\b(alert|alarm|canary|incident|outage)\b/.test(t) ||
    /\b(alert|alarm|canary|incident|outage)\b.{0,80}\b(prod|production|staging)\b/.test(t)
  );
}

// Route a free-text Slack/Jira request to the right worker + repo. Backend signals
// ("backend", "back-end", operational alarms/canaries, or an explicit "be:" prefix) →
// the lambdas repo; everything else defaults to the frontend app.
function routeIntent(text: string): { type: WorkerType; repo: string } {
  const t = (text || '').toLowerCase();
  const backend = t.trimStart().startsWith('be:') || hasBackendTextSignal(t);
  const type: WorkerType = backend ? 'be' : 'fe';
  return { type, repo: REPO_BY_TYPE[type] };
}

// Route a Jira ticket to a repo using its structured signals (most reliable first): the
// frontend/backend labels, then the FE:/BE:/Frontend:/Backend: summary prefix, then a text
// fallback. `isDesign` flags Figma/design tickets that aren't coding tasks.
function routeIntentFromJira(issue: JiraIssue): { type: WorkerType; repo: string; isDesign: boolean } {
  const labelSet = new Set(issue.labels.map((l) => l.toLowerCase()));
  const s = (issue.summary || '').toLowerCase();
  const parent = (issue.parentSummary || '').toLowerCase();
  const allText = [issue.summary, issue.issueType, issue.parentSummary, issue.context, issue.labels.join(' ')].filter(Boolean).join('\n');
  const isDesign = labelSet.has('design') || /^\s*design\s*:/.test(s);
  const explicitFrontend = labelSet.has('frontend') || labelSet.has('fe') || /^\s*(fe|frontend)\s*:/.test(s);
  const explicitBackend =
    labelSet.has('backend') ||
    labelSet.has('be') ||
    /^\s*(be|backend)\s*:/.test(s) ||
    /\bbackend\b/.test(parent);
  const backend =
    explicitBackend ||
    (!explicitFrontend && (routeIntent(issue.summary).type === 'be' || hasBackendTextSignal(allText)));
  const type: WorkerType = backend ? 'be' : 'fe';
  return { type, repo: REPO_BY_TYPE[type], isDesign };
}

function refreshFlowRoute(flow: JiraFlow, issue: JiraIssue): JiraFlow {
  const { type, repo } = routeIntentFromJira(issue);
  if (flow.type === type && flow.repo === repo) return flow;
  return {
    ...flow,
    type,
    repo,
    taskPrompt: flow.taskPrompt.replace(/donate-mate\/donatemate-app|donate-mate\/donatemate/g, repo),
  };
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

  const reply = await converse(history, { jiraContext });
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
  const body = (req.body ?? {}) as {
    prompt?: string;
    type?: WorkerType;
    issueKey?: string;
    phase?: string;
    author?: string;
    text?: string;
  };

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
  const work =
    phase === 'confirm'
      ? handleJiraConfirm(issueKey, body.author)
      : phase === 'comment'
        ? handleJiraComment(issueKey, body.text, body.author)
        : phase === 'done'
          ? handleJiraDone(issueKey, body.author)
        : processJiraAssignment(issueKey);
  work.catch((err) => app.log.error({ err, issueKey, phase }, 'jira webhook handler failed'));
});

// ---------------------------------------------------------------------------
// GitHub webhooks + manual reconciliation
// ---------------------------------------------------------------------------
app.post('/github/webhook', async (req, reply) => {
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  try {
    const result = await handleGitHubWebhook(raw, req.headers, (req.body ?? {}) as Record<string, unknown>, app.log);
    return reply.send(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('signature')) return reply.code(401).send({ error: msg });
    app.log.error({ err }, 'github webhook failed');
    return reply.code(500).send({ error: 'github webhook failed' });
  }
});

app.post('/github/reconcile', async (req, reply) => {
  const { sharedSecret } = await getSecretJson(process.env.SECRET_JIRA_WEBHOOK!);
  const provided = String(req.headers['x-hermes-secret'] ?? '');
  if (!sharedSecret || provided !== sharedSecret) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  await reconcileOpenPrs(app.log);
  return reply.send({ ok: true });
});

// Conversation thread key for a Jira ticket (mirrors Slack's convo store, channel "jira").
const JIRA_CHANNEL = 'jira';

const assignmentProcessor = {
  tryClaim: tryClaimJiraAssignment,
  process: (event: { issueKey: string; assignedAt: string }) => handleJiraAssigned(event.issueKey, event.assignedAt),
  complete: completeJiraAssignmentClaim,
  release: releaseJiraAssignmentClaim,
};

/**
 * Run the webhook path through the same distributed changelog-event claim as the polling fallback.
 * This prevents a normal webhook and a safety-net sweep (or two control-plane replicas) from
 * planning/commenting the same assignment twice.
 */
async function processJiraAssignment(issueKey: string): Promise<void> {
  const botAccountId = await getBotAccountId();
  if (!botAccountId) {
    app.log.warn({ issueKey }, 'Jira bot accountId unavailable; processing assignment without event dedupe');
    await handleJiraAssigned(issueKey);
    return;
  }

  const event = await fetchLatestHermesAssignmentEvent(issueKey, botAccountId);
  if (!event) {
    // Jira's issue event normally follows the persisted changelog write. Fail open if eventual
    // consistency or an older webhook prevents us from resolving the concrete event.
    app.log.warn({ issueKey }, 'Jira assignment changelog event unavailable; processing without event dedupe');
    await handleJiraAssigned(issueKey);
    return;
  }
  await processJiraAssignmentEvent(event, assignmentProcessor);
}

let jiraAssignmentSweepRunning = false;
async function reconcileMissedJiraAssignments(): Promise<void> {
  if (jiraAssignmentSweepRunning) return;
  jiraAssignmentSweepRunning = true;
  try {
    const botAccountId = await getBotAccountId();
    if (!botAccountId) throw new Error('Jira bot accountId is not configured');
    const events = await fetchRecentHermesAssignmentEvents(botAccountId, JIRA_ASSIGNMENT_LOOKBACK_DAYS);
    const result = await reconcileJiraAssignmentEvents(events, assignmentProcessor, (event, err) =>
      app.log.error({ err, issueKey: event.issueKey, assignmentEventId: event.eventId }, 'Jira assignment reconciliation failed')
    );
    if (result.processed || result.failed) {
      app.log.info(result, 'Jira assignment reconciliation completed');
    }
  } finally {
    jiraAssignmentSweepRunning = false;
  }
}

// Ticket assigned to Hermes → derive a plan, store it, and comment for confirmation. Does NOT
// run the agent yet. Idempotent: a re-assignment while running is a no-op.
async function handleJiraAssigned(issueKey: string, assignedAt?: string): Promise<void> {
  const existing = await getFlow(issueKey);
  // A webhook can arrive after the polling safety net (or vice versa). If this exact assignment
  // already produced newer flow state, only finish its event marker; do not post a duplicate plan.
  if (
    assignedAt &&
    existing?.updatedAt &&
    Number.isFinite(Date.parse(assignedAt)) &&
    Date.parse(existing.updatedAt) >= Date.parse(assignedAt)
  ) {
    return;
  }
  const issue = await fetchIssue(issueKey);
  if (!issue) {
    await commentOnIssue(issueKey, "⚠️ I couldn't read this ticket's details — check my Jira access.");
    throw new Error(`Unable to read Jira issue ${issueKey}`);
  }

  const { type, repo, isDesign } = routeIntentFromJira(issue);
  if (existing?.status === 'running' && existing.type === type && existing.repo === repo) {
    await commentOnIssue(issueKey, `🤖 I'm already working on this (job \`${existing.jobId}\`).`);
    return;
  }
  if (existing?.status === 'running') {
    await commentOnIssue(
      issueKey,
      `⚠️ My existing flow was scoped to \`${existing.repo}\` (${existing.type.toUpperCase()}), but the current ticket routes to \`${repo}\` (${type.toUpperCase()}). I'll re-plan against the corrected repo.`
    );
  }

  if (isDesign) {
    await commentOnIssue(
      issueKey,
      "ℹ️ This looks like a **design** ticket, not a coding task, so I won't pick it up. Unassign me if that was unintended, or reassign once there's a concrete code change to make."
    );
    return;
  }

  const plan = await planIssue(issue.context);
  const taskPrompt = `Implement Jira issue ${issueKey}: ${issue.summary}\n\nPlanned approach:\n${plan}`;
  // --- WS5 --- Derive a readiness checklist from the ticket (env-gated, fail-open).
  const checklist = CHECKLIST_ENABLED ? await extractChecklist(issue.context).catch(() => [] as string[]) : undefined;
  await setFlow(issueKey, { status: 'awaiting_confirm', taskPrompt, repo, type, plan, checklist });

  // Seed a FRESH per-ticket conversation so follow-up comments refine this plan (Slack-thread
  // parity). Reset first so a re-assignment re-plans from scratch, not on top of an old run.
  await resetConversation(JIRA_CHANNEL, issueKey);
  await appendMessage(JIRA_CHANNEL, issueKey, { role: 'user', content: `Ticket ${issueKey}: ${issue.summary}\n\n${issue.context}` });
  await appendMessage(JIRA_CHANNEL, issueKey, { role: 'assistant', content: plan });

  await commentOnIssue(
    issueKey,
    `🤖 **Hermes here.** I'll work this against \`${repo}\` (${type.toUpperCase()}).\n\n**Plan**\n\n${plan}\n\n---\n\nReply \`/go\` to start, comment to refine the plan, or re-assign me to re-plan from scratch.`
  );
}

// A non-/go comment on an assigned ticket → conversationally refine the plan (same engine as the
// Slack chat). Ignores Hermes's own comments and only refines while awaiting confirmation.
async function handleJiraComment(issueKey: string, text?: string, author?: string): Promise<void> {
  if (author) {
    const botId = await getBotAccountId();
    if (botId && author === botId) return; // never react to our own comments
  }
  const clean = (text ?? '').trim();
  if (!clean) return;

  let flow = await getFlow(issueKey);
  if (!flow || flow.status !== 'awaiting_confirm') return; // only refine before the job is queued

  await appendMessage(JIRA_CHANNEL, issueKey, { role: 'user', content: clean });
  const history = await getConversation(JIRA_CHANNEL, issueKey);
  const issue = await fetchIssue(issueKey);
  if (issue) {
    const refreshed = refreshFlowRoute(flow, issue);
    if (refreshed !== flow) {
      flow = refreshed;
      await setFlow(issueKey, flow);
    }
  }
  const reply = await converse(history, { jiraContext: issue?.context, startCommand: '/go' });
  await appendMessage(JIRA_CHANNEL, issueKey, { role: 'assistant', content: reply });
  await commentOnIssue(issueKey, reply);
}

// `/go` confirmation → queue the job and advance the board. Guarded against Hermes's own plan
// comment (which contains the literal "/go") self-triggering the confirm rule.
async function handleJiraConfirm(issueKey: string, author?: string): Promise<void> {
  if (author) {
    const botId = await getBotAccountId();
    if (botId && author === botId) return; // ignore Hermes's own comments — no feedback loop
  }

  const flow = await getFlow(issueKey);
  if (!flow) {
    await commentOnIssue(issueKey, 'ℹ️ Assign this ticket to me first, then reply `/go` to start.');
    return;
  }
  const issue = await fetchIssue(issueKey);
  const routedFlow = issue ? refreshFlowRoute(flow, issue) : flow;
  if (flow.status === 'running') {
    if (routedFlow !== flow) {
      await setFlow(issueKey, { ...routedFlow, status: 'awaiting_confirm', jobId: undefined });
      await commentOnIssue(
        issueKey,
        `⚠️ My existing flow was scoped to \`${flow.repo}\` (${flow.type.toUpperCase()}), but this ticket now routes to \`${routedFlow.repo}\` (${routedFlow.type.toUpperCase()}). I updated the stored plan to the corrected repo. Reply \`/go\` again to start the backend-scoped job.`
      );
      return;
    }
    await commentOnIssue(issueKey, `🤖 Already on it — job \`${flow.jobId}\`.`);
    return;
  }
  if (flow.status === 'done') {
    await commentOnIssue(issueKey, 'ℹ️ My last run for this ticket already finished. Re-assign me to start a fresh run.');
    return;
  }

  if (routedFlow !== flow) {
    await setFlow(issueKey, routedFlow);
  }

  // If the plan was refined via comments, condense the whole conversation into the task so the
  // clarifications are baked in; otherwise fall back to the original plan-derived prompt.
  let prompt = routedFlow.taskPrompt;
  const msgs = await getConversation(JIRA_CHANNEL, issueKey);
  if (msgs.length > 2) {
    const transcript = msgs.map((m) => `${m.role === 'assistant' ? 'Hermes' : 'User'}: ${m.content}`).join('\n');
    prompt = `Implement Jira issue ${issueKey}.\n\n${await conversationToTask(transcript)}`;
  }

  const job = await createJob({
    type: routedFlow.type,
    repo: routedFlow.repo,
    prompt,
    source: `jira:${issueKey}`,
  });
  await setFlow(issueKey, { ...routedFlow, status: 'running', jobId: job.jobId });
  await transitionIssue(issueKey, COLUMN.inProgress);
  await commentOnIssue(
    issueKey,
    `🛠️ Starting implementation — job \`${job.jobId}\` against \`${routedFlow.repo}\`. I'll comment with the PR when it's ready.`
  );
}

async function handleJiraDone(issueKey: string, _author?: string): Promise<void> {
  // Unlike comment/confirm hooks, Done scenario capture must run even when Hermes moved the
  // issue to Done after a passing QA proof.
  const issue = await fetchIssue(issueKey);
  if (!issue) {
    await commentOnIssue(issueKey, "⚠️ I couldn't read this ticket to complete QA scenario capture.");
    return;
  }
  const result = await captureQaScenarioForDone(issueKey, issue);
  await commentOnIssue(issueKey, result.message);
  if (result.status === 'needs_human') {
    await transitionIssue(issueKey, COLUMN.blocked);
  }
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

if (PR_RECONCILE_SECONDS > 0) {
  const run = () =>
    reconcileOpenPrs(app.log, { periodic: true }).catch((err) => app.log.error({ err }, 'periodic PR reconciliation failed'));
  setInterval(run, PR_RECONCILE_SECONDS * 1000).unref();
  setTimeout(run, 30_000).unref();
}

if (JIRA_ASSIGNMENT_RECONCILE_SECONDS > 0) {
  const run = () =>
    reconcileMissedJiraAssignments().catch((err) => app.log.error({ err }, 'periodic Jira assignment reconciliation failed'));
  setInterval(run, JIRA_ASSIGNMENT_RECONCILE_SECONDS * 1000).unref();
  // Start promptly on deploy so assignments missed during an Automation outage are replayed.
  setTimeout(run, 10_000).unref();
}

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`hermes-control-plane listening on ${addr}`))
  .catch((err) => {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  });
