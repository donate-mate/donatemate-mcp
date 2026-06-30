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

const PORT = Number(process.env.PORT ?? 3000);

// Default repo per worker type. FE = the Expo app; BE = the lambdas monorepo.
const REPO_BY_TYPE: Record<WorkerType, string> = {
  fe: 'donate-mate/donatemate-app',
  be: 'donate-mate/donatemate',
  qa: 'donate-mate/donatemate-app',
};

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

async function handleSlackEvent(body: Record<string, unknown>): Promise<void> {
  const event = body.event as
    | { type?: string; text?: string; channel?: string; thread_ts?: string; ts?: string; user?: string; bot_id?: string }
    | undefined;
  if (!event || event.bot_id) return; // ignore our own / other bots
  if (event.type !== 'app_mention' && event.type !== 'message') return;

  const prompt = stripMention(event.text ?? '');
  if (!prompt) return;

  const threadTs = event.thread_ts ?? event.ts;
  // MVP routing: Slack tasks default to the FE app. Deeper intent/repo parsing + multi-turn
  // thread→session continuation is a follow-up (threadTs is persisted on the job for that).
  const job = await createJob({
    type: 'fe',
    repo: REPO_BY_TYPE.fe,
    prompt,
    source: 'slack',
    channel: event.channel,
    threadTs,
    requestedBy: event.user,
  });

  if (event.channel) {
    await postSlackMessage(
      event.channel,
      `:robot_face: On it — queued job \`${job.jobId}\` against \`${job.repo}\`. I'll post the PR here when it's ready.`,
      threadTs
    );
  }
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
