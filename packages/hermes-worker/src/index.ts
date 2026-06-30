/**
 * Hermes FE Worker
 *
 * Long-polls the SQS jobs queue. For each job: clean shallow clone of the target repo (with a
 * per-job GitHub App token), create a work branch, run Claude Code headless, and — if the agent
 * produced changes — commit, push, and open a PR. Results are written to DynamoDB + S3 and
 * posted back to Slack/Jira. Ephemeral workspace per job (no shared mutable state — avoids the
 * pet-VM failure mode).
 *
 * Run: `tsx src/index.ts` (containerized; image includes git + the `claude` CLI).
 */
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInstallationAuth,
  cloneRepo,
  createBranch,
  hasChanges,
  commitAndPush,
  openPullRequest,
} from './github.js';
import { runAgent } from './agent.js';
import { getJob, updateJob, storeTranscript } from './jobs.js';
import { notify } from './notify.js';

const sqs = new SQSClient({});
const QUEUE = process.env.JOBS_QUEUE_URL!;
const WORKER_TYPE = process.env.WORKER_TYPE ?? 'fe';

async function processJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) {
    console.warn(`[${jobId}] job not found in table; skipping`);
    return;
  }
  console.log(`[${jobId}] processing against ${job.repo}@${job.baseBranch}`);
  await updateJob(jobId, 'running');

  const dir = await mkdtemp(join(tmpdir(), `hermes-${jobId}-`));
  try {
    const branch = `hermes/${jobId.slice(0, 8)}`;
    const { token, octokit } = await getInstallationAuth(job.repo);
    await cloneRepo(token, job.repo, job.baseBranch, dir);
    await createBranch(dir, branch);

    const { transcript, exitCode } = await runAgent(dir, job.prompt);
    const transcriptUri = await storeTranscript(jobId, transcript);

    if (!(await hasChanges(dir))) {
      await updateJob(jobId, 'failed', { error: 'agent produced no changes', transcriptUri });
      await notify(job, `:warning: Hermes job \`${jobId}\` finished but made no changes.`);
      return;
    }

    const title = `[hermes] ${job.prompt.slice(0, 60)}`;
    const body = [
      `Automated PR by **Hermes** (job \`${jobId}\`, source: ${job.source}).`,
      '',
      '**Task**',
      `> ${job.prompt}`,
      '',
      `Agent exit code: ${exitCode}. Transcript: ${transcriptUri}`,
      '',
      '⚠️ Agent-generated — review before merge.',
    ].join('\n');

    await commitAndPush(dir, branch, title);
    const prUrl = await openPullRequest(octokit, job.repo, branch, job.baseBranch, title, body);

    await updateJob(jobId, 'done', { prUrl, transcriptUri });
    await notify(job, `:white_check_mark: Hermes opened a PR for job \`${jobId}\`: ${prUrl}`);
    console.log(`[${jobId}] done → ${prUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${jobId}] failed:`, msg);
    await updateJob(jobId, 'failed', { error: msg });
    await notify(job, `:x: Hermes job \`${jobId}\` failed: ${msg}`);
    throw err; // do not delete the SQS message → redelivery, then DLQ
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loop(): Promise<void> {
  console.log(`hermes-worker (${WORKER_TYPE}) polling ${QUEUE}`);
  for (;;) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 3600,
      })
    );
    for (const m of res.Messages ?? []) {
      try {
        const { jobId } = JSON.parse(m.Body || '{}') as { jobId?: string };
        if (jobId) await processJob(jobId);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE, ReceiptHandle: m.ReceiptHandle! }));
      } catch (err) {
        // Leave the message un-deleted → SQS redelivers up to maxReceiveCount, then DLQ.
        console.error('job processing error (will retry / DLQ):', err);
      }
    }
  }
}

loop().catch((err) => {
  console.error('worker crashed:', err);
  process.exit(1);
});
