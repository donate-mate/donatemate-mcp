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
import { converse, conversationToTask } from './converse.js';
import { appendMessage, getConversation, setActivePointer, getActivePointer } from './convo.js';
import { findIssueKey, fetchIssueContext } from './jira.js';

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
// ---------------------------------------------------------------------------
app.post('/jira/webhook', async (req, reply) => {
  const { sharedSecret } = await getSecretJson(process.env.SECRET_JIRA_WEBHOOK!);
  const provided = String(req.headers['x-hermes-secret'] ?? '');
  if (!sharedSecret || provided !== sharedSecret) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = (req.body ?? {}) as { prompt?: string; type?: WorkerType; issueKey?: string };
  if (!body.prompt) return reply.code(400).send({ error: 'prompt required' });

  const type = body.type ?? 'fe';
  const job = await createJob({
    type,
    repo: REPO_BY_TYPE[type],
    prompt: body.prompt,
    source: body.issueKey ? `jira:${body.issueKey}` : 'jira',
  });
  return reply.send({ ok: true, jobId: job.jobId });
});

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
