/**
 * Hermes FE Worker
 *
 * Long-polls the SQS jobs queue. Initial jobs create a clean work branch and open a PR. Follow-up
 * jobs clone the existing PR branch, address compact CI/review feedback, and push back to that
 * same branch. Results are written to DynamoDB + S3 and posted back to Slack/Jira.
 *
 * Run: `tsx src/index.ts` (containerized; image includes git + the `codex` CLI).
 */
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInstallationAuth,
  commentOnPullRequest,
  cloneRepo,
  createBranch,
  getHeadSha,
  hasChanges,
  commitAndPush,
  openPullRequest,
  ensurePullRequestLabels,
  prepareMergeConflictResolution,
  type MergeConflictPreparation,
} from './github.js';
import { runAgent } from './agent.js';
import {
  getJob,
  updateJob,
  touchJob,
  storeTranscript,
  markFlowDone,
  markFlowRunning,
  markPrWatchQaFailed,
  markPrWatchWaiting,
  recordPrWatch,
} from './jobs.js';
import { notify } from './notify.js';
import { setScaleInProtection } from './taskprotection.js';
import { findIssueKey, fetchIssueContext } from './jira.js';
import { commentOnIssue, transitionIssue, COLUMN, jiraIssueKey } from './jiraBot.js';
import { processQaProofJob } from './qaRunner.js';
import { processDeploymentVerificationJob } from './deployVerifier.js';

const sqs = new SQSClient({});
const QUEUE = process.env.JOBS_QUEUE_URL!;
const WORKER_TYPE = process.env.WORKER_TYPE ?? 'fe';
const FRONTEND_DEPLOY_LABEL = 'deploy-dev';
const JOB_HEARTBEAT_SECONDS = Number(process.env.JOB_HEARTBEAT_SECONDS ?? 60);
const PRECOMMIT_REPAIR_ATTEMPTS = Number(process.env.PRECOMMIT_REPAIR_ATTEMPTS ?? 2);
const FAILURE_COMMENT_MAX = 2400;

function startJobHeartbeat(jobId: string): () => void {
  const interval = setInterval(() => {
    touchJob(jobId).catch((err) =>
      console.warn(`[${jobId}] failed to update job heartbeat:`, err instanceof Error ? err.message : String(err))
    );
  }, JOB_HEARTBEAT_SECONDS * 1000);
  interval.unref();
  return () => clearInterval(interval);
}

function mergeConflictPrompt(jobBaseBranch: string, prep: MergeConflictPreparation): string {
  const conflictList = prep.conflicts.length
    ? prep.conflicts.map((file) => `- ${file}`).join('\n')
    : '- Git reported conflicts but did not return conflicted file paths.';
  return [
    'The harness has already fetched the PR base branch and attempted to merge it into this PR branch.',
    '',
    `Base branch: ${jobBaseBranch}`,
    `Merge status: ${prep.status}`,
    '',
    'Conflicted files:',
    conflictList,
    '',
    'Resolve the merge conflicts in the working tree, remove all conflict markers, preserve both the original PR intent and the current base-branch behavior, then run the narrowest relevant validation.',
    '',
    prep.output ? `Git merge output:\n${prep.output}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const extra = [
      'stdout' in err ? String((err as { stdout?: unknown }).stdout ?? '') : '',
      'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '',
    ]
      .filter(Boolean)
      .join('\n');
    return [err.message, extra].filter(Boolean).join('\n');
  }
  return String(err);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function compactText(value: string, max = FAILURE_COMMENT_MAX): string {
  const normalized = stripAnsi(value)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join('\n')
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}\n...truncated`;
}

function looksLikePrecommitFailure(value: string): boolean {
  return (
    /git .*commit|pre-commit|husky|lint-staged|Running tasks for staged files/i.test(value) &&
    /eslint|prettier|tsc|type-check|lint|format/i.test(value)
  );
}

function buildPrecommitRepairPrompt(originalTask: string, failure: string, attempt: number): string {
  return [
    `The harness attempted to commit your existing edits, but the repository pre-commit checks failed on attempt ${attempt}.`,
    '',
    'Fix only the formatting/lint/typecheck issues needed for the commit hook to pass.',
    'Preserve the implementation intent and avoid broad refactors or unrelated cleanup.',
    'Do not run git commands; leave repaired edits in the working tree for the harness to commit.',
    '',
    'Original task:',
    originalTask,
    '',
    'Pre-commit failure summary:',
    '```text',
    compactText(failure, 6000),
    '```',
  ].join('\n');
}

function formatFailureComment(input: {
  jobId: string;
  message: string;
  transcriptUri?: string;
  action?: string;
}): string {
  return [
    `❌ I hit a blocker and couldn't finish job \`${input.jobId}\`.`,
    '',
    `Reason:\n\`\`\`text\n${compactText(input.message)}\n\`\`\``,
    input.transcriptUri ? `Transcript: \`${input.transcriptUri}\`` : undefined,
    '',
    input.action ?? 'Moving back to **To Do**.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function commitAndPushWithPrecommitRepair(input: {
  jobId: string;
  dir: string;
  branch: string;
  message: string;
  taskPrompt: string;
  transcript: string;
}): Promise<string> {
  let transcript = input.transcript;
  let transcriptUri = await storeTranscript(input.jobId, transcript);

  for (let attempt = 0; attempt <= PRECOMMIT_REPAIR_ATTEMPTS; attempt++) {
    try {
      await commitAndPush(input.dir, input.branch, input.message);
      return transcriptUri;
    } catch (err) {
      const failure = errorText(err);
      if (attempt >= PRECOMMIT_REPAIR_ATTEMPTS || !looksLikePrecommitFailure(failure)) {
        throw new Error(compactText(failure, 8000));
      }

      const repairPrompt = buildPrecommitRepairPrompt(input.taskPrompt, failure, attempt + 1);
      console.warn(`[${input.jobId}] pre-commit failed; running repair attempt ${attempt + 1}/${PRECOMMIT_REPAIR_ATTEMPTS}`);
      const repair = await runAgent(input.dir, repairPrompt);
      transcript = [
        transcript,
        '',
        `--- Pre-commit repair attempt ${attempt + 1} ---`,
        '',
        repair.transcript || `(agent exited ${repair.exitCode} without transcript)`,
      ].join('\n');
      transcriptUri = await storeTranscript(input.jobId, transcript);
    }
  }

  return transcriptUri;
}

async function completeFollowupJob(input: {
  jobId: string;
  job: Awaited<ReturnType<typeof getJob>>;
  ticket?: string;
  branch: string;
  dir: string;
  transcript: string;
  message: string;
  octokit: Awaited<ReturnType<typeof getInstallationAuth>>['octokit'];
}): Promise<void> {
  const { jobId, job, ticket, branch, dir, transcript, message, octokit } = input;
  if (!job) throw new Error('job missing during follow-up completion');
  if (!job.prNumber || !job.prUrl) throw new Error('follow-up job missing prNumber/prUrl');

  const transcriptUri = await commitAndPushWithPrecommitRepair({
    jobId,
    dir,
    branch,
    message: `[hermes] address PR feedback (${jobId.slice(0, 8)})`,
    taskPrompt: job.prompt,
    transcript,
  });
  const headSha = await getHeadSha(dir);
  await updateJob(jobId, 'done', { prUrl: job.prUrl, transcriptUri, headSha });
  await markPrWatchWaiting(job.repo, job.prNumber, headSha);
  await notify(job, `:white_check_mark: ${message} Waiting for CI.`);

  // Respond on the PR itself with what was fixed (mirrors the Jira/Slack write-back).
  await commentOnPullRequest(
    octokit,
    job.repo,
    job.prNumber,
    [
      `🤖 **Hermes** pushed a fix to this PR.`,
      '',
      job.feedbackSummary ? `**Addressed:**\n${job.feedbackSummary}` : 'Addressed the latest CI / review feedback.',
      '',
      `Commit \`${headSha.slice(0, 7)}\` — re-running CI. _Automated fix; please re-review._`,
    ].join('\n')
  );

  if (ticket) {
    await commentOnIssue(
      ticket,
      [
        `✅ ${message}`,
        '',
        `PR: ${job.prUrl}`,
        '',
        job.feedbackSummary ? `Addressed feedback:\n${job.feedbackSummary}` : 'Addressed the latest PR feedback.',
        '',
        'Waiting for CI to rerun.',
      ].join('\n')
    );
    await transitionIssue(ticket, COLUMN.waitingCi);
    await markFlowRunning(ticket, { prUrl: job.prUrl, lastFixJobId: jobId });
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) {
    console.warn(`[${jobId}] job not found in table; skipping`);
    return;
  }
  if (job.status === 'done' || job.status === 'failed') {
    console.warn(`[${jobId}] job is already ${job.status}; skipping stale queue message`);
    return;
  }
  const kind = job.kind ?? 'implementation';
  if (kind === 'deploy_verification') {
    console.log(`[${jobId}] processing deployment verification for ${job.repo}@${job.headSha ?? job.baseBranch}`);
    await updateJob(jobId, 'running');
    const stopHeartbeat = startJobHeartbeat(jobId);
    await setScaleInProtection(true);
    try {
      await processDeploymentVerificationJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${jobId}] deployment verification failed:`, msg);
      await updateJob(jobId, 'failed', { error: msg });
      await notify(job, `:x: Hermes deployment verification job \`${jobId}\` failed: ${msg}`);
      if (job.issueKey && job.prNumber) {
        await markPrWatchQaFailed(job.repo, job.prNumber, msg);
        await commentOnIssue(job.issueKey, `❌ Post-merge deployment verification failed: ${msg}`);
        await transitionIssue(job.issueKey, COLUMN.blocked);
        await markFlowDone(job.issueKey, { flowError: msg.slice(0, 200), prUrl: job.prUrl ?? '' });
      }
      throw err;
    } finally {
      stopHeartbeat();
      await setScaleInProtection(false);
    }
    return;
  }
  if (kind === 'qa_proof') {
    console.log(`[${jobId}] processing QA proof against ${job.repo}@${job.headSha ?? job.baseBranch}`);
    await updateJob(jobId, 'running');
    const stopHeartbeat = startJobHeartbeat(jobId);
    await setScaleInProtection(true);
    try {
      await processQaProofJob(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${jobId}] QA proof failed:`, msg);
      await updateJob(jobId, 'failed', { error: msg });
      await notify(job, `:x: Hermes QA proof job \`${jobId}\` failed: ${msg}`);
      if (job.issueKey && job.prNumber) {
        await markPrWatchQaFailed(job.repo, job.prNumber, msg);
        await commentOnIssue(job.issueKey, `❌ Post-merge QA proof failed: ${msg}`);
        await transitionIssue(job.issueKey, COLUMN.blocked);
        await markFlowDone(job.issueKey, { flowError: msg.slice(0, 200), prUrl: job.prUrl ?? '' });
      }
      throw err;
    } finally {
      stopHeartbeat();
      await setScaleInProtection(false);
    }
    return;
  }
  const isFollowup = kind === 'ci_fix' || kind === 'review_fix' || kind === 'combined_followup';
  const isMergeConflictFollowup = kind === 'merge_conflict_fix';
  const isPrFollowup = isFollowup || isMergeConflictFollowup;
  console.log(`[${jobId}] processing ${kind} against ${job.repo}@${isPrFollowup ? job.headBranch : job.baseBranch}`);
  const ticket = job.issueKey ?? jiraIssueKey(job.source); // non-null → write progress back to this Jira issue
  await updateJob(jobId, 'running');
  const stopHeartbeat = startJobHeartbeat(jobId);
  await setScaleInProtection(true); // don't let the autoscaler kill us mid-job

  const dir = await mkdtemp(join(tmpdir(), `hermes-${jobId}-`));
  try {
    const branch = isPrFollowup ? job.headBranch : `hermes/${jobId.slice(0, 8)}`;
    if (!branch) throw new Error('follow-up job missing headBranch');
    const { token, octokit } = await getInstallationAuth(job.repo);
    await cloneRepo(token, job.repo, isPrFollowup ? branch : job.baseBranch, dir);
    if (!isPrFollowup) await createBranch(dir, branch);
    const baseSha = await getHeadSha(dir); // baseline to detect agent commits, not just dirty tree

    let mergePrep: MergeConflictPreparation | undefined;
    if (isMergeConflictFollowup) {
      mergePrep = await prepareMergeConflictResolution(dir, job.baseBranch);
      const transcript = [
        `Merge-conflict preparation for ${job.prUrl ?? job.repo}.`,
        `Base branch: ${job.baseBranch}`,
        `Status: ${mergePrep.status}`,
        mergePrep.conflicts.length ? `Conflicts:\n${mergePrep.conflicts.map((file) => `- ${file}`).join('\n')}` : undefined,
        mergePrep.output ? `Git output:\n${mergePrep.output}` : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');

      if (mergePrep.status !== 'conflicted') {
        await completeFollowupJob({
          jobId,
          job,
          ticket: ticket ?? undefined,
          branch,
          dir,
          transcript,
          octokit,
          message:
            mergePrep.status === 'merged_cleanly'
              ? `Hermes reconciled the PR branch with \`${job.baseBranch}\` without manual conflict edits.`
              : `Hermes rechecked the PR branch against \`${job.baseBranch}\`; it is already up to date.`,
        });
        console.log(`[${jobId}] merge-conflict follow-up completed without manual edits → ${job.prUrl}`);
        return;
      }
    }

    // If the task references a Jira issue, pull its context so the agent builds the right thing.
    let prompt = job.prompt;
    const issueKey = ticket ?? findIssueKey(`${job.source} ${job.prompt}`);
    if (issueKey) {
      const ctx = await fetchIssueContext(issueKey);
      if (ctx) {
        console.log(`[${jobId}] enriched prompt with Jira ${issueKey}`);
        prompt = `Context from ${ctx}\n\n---\n\nTask:\n${job.prompt}`;
      }
    }
    if (mergePrep?.status === 'conflicted') {
      prompt = `${prompt}\n\n---\n\nMerge conflict resolution context:\n${mergeConflictPrompt(job.baseBranch, mergePrep)}`;
    }

    const { transcript, exitCode, reason } = await runAgent(dir, prompt);
    let transcriptUri = await storeTranscript(jobId, transcript);

    if (!(await hasChanges(dir, baseSha))) {
      const why = reason ? ` (${reason})` : '';
      await updateJob(jobId, 'failed', { error: `agent produced no changes${why}`, transcriptUri });
      await notify(job, `:warning: Hermes job \`${jobId}\` finished but made no changes${why}.`);
      if (ticket) {
        await commentOnIssue(
          ticket,
          isPrFollowup
            ? `⚠️ I tried to address the latest PR feedback but produced no code changes${why}. Transcript: \`${transcriptUri}\``
            : `⚠️ I ran but produced no code changes${why}. Transcript: \`${transcriptUri}\`\n\nMoving back to **To Do** — add detail or narrow the scope and re-assign me.`
        );
        if (!isPrFollowup) {
          await transitionIssue(ticket, COLUMN.toDo);
          await markFlowDone(ticket, { flowError: 'no changes' });
        }
      }
      return;
    }

    const title = isPrFollowup ? `[hermes] address PR feedback (${jobId.slice(0, 8)})` : `[hermes] ${job.prompt.slice(0, 60)}`;
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

    transcriptUri = await commitAndPushWithPrecommitRepair({
      jobId,
      dir,
      branch,
      message: title,
      taskPrompt: prompt,
      transcript,
    });
    const headSha = await getHeadSha(dir);

    if (isPrFollowup) {
      if (!job.prNumber || !job.prUrl) throw new Error('follow-up job missing prNumber/prUrl');
      await updateJob(jobId, 'done', { prUrl: job.prUrl, transcriptUri, headSha });
      await markPrWatchWaiting(job.repo, job.prNumber, headSha);
      await notify(
        job,
        `:white_check_mark: Hermes pushed a follow-up fix for PR ${job.prUrl}${isMergeConflictFollowup ? ' after resolving merge conflicts' : ''}. Waiting for CI.`
      );
      if (ticket) {
        await commentOnIssue(
          ticket,
          [
            `✅ I pushed a follow-up fix to the PR branch: ${job.prUrl}`,
            isMergeConflictFollowup ? 'Merge conflicts were resolved against the current base branch.' : undefined,
            '',
            job.feedbackSummary ? `Addressed feedback:\n${job.feedbackSummary}` : 'Addressed the latest PR feedback.',
            '',
            'Waiting for CI to rerun.',
          ]
            .filter((line) => line !== undefined)
            .join('\n')
        );
        await transitionIssue(ticket, COLUMN.waitingCi);
        await markFlowRunning(ticket, { prUrl: job.prUrl, lastFixJobId: jobId });
      }
      console.log(`[${jobId}] follow-up pushed → ${job.prUrl}`);
      return;
    }

    const pr = await openPullRequest(octokit, job.repo, branch, job.baseBranch, title, body);
    if (job.type === 'fe') {
      await ensurePullRequestLabels(octokit, job.repo, pr.number, [FRONTEND_DEPLOY_LABEL]);
    }

    await recordPrWatch({
      repo: job.repo,
      prNumber: pr.number,
      prUrl: pr.url,
      sourceJobId: jobId,
      type: job.type,
      baseBranch: job.baseBranch,
      headBranch: branch,
      headSha,
      originalPrompt: job.prompt,
      issueKey: ticket ?? undefined,
      channel: job.channel,
      threadTs: job.threadTs,
    });
    await updateJob(jobId, 'done', { prUrl: pr.url, prNumber: pr.number, headBranch: branch, headSha, transcriptUri });
    await notify(job, `:white_check_mark: Hermes opened a PR for job \`${jobId}\`: ${pr.url}`);
    if (ticket) {
      await commentOnIssue(ticket, `✅ PR opened: ${pr.url}\n\nI'll monitor CI and review feedback, then push scoped follow-up fixes when needed.`);
      await transitionIssue(ticket, COLUMN.codeReview);
      await markFlowRunning(ticket, { prUrl: pr.url });
    }
    console.log(`[${jobId}] done → ${pr.url}`);
  } catch (err) {
    const msg = errorText(err);
    const compactMsg = compactText(msg, 8000);
    const failureLogUri = msg.length > compactMsg.length ? await storeTranscript(jobId, msg) : undefined;
    console.error(`[${jobId}] failed:`, msg);
    await updateJob(jobId, 'failed', {
      error: compactMsg,
      ...(failureLogUri ? { failureLogUri } : {}),
    });
    await notify(job, `:x: Hermes job \`${jobId}\` failed: ${compactText(msg, 1200)}`);
    if (ticket) {
      await commentOnIssue(
        ticket,
        formatFailureComment({
          jobId,
          message: msg,
          transcriptUri: failureLogUri,
          action: 'Moving back to **To Do**.',
        })
      );
      await transitionIssue(ticket, COLUMN.toDo);
      await markFlowDone(ticket, { flowError: msg.slice(0, 200) });
    }
    throw err; // do not delete the SQS message → redelivery, then DLQ
  } finally {
    stopHeartbeat();
    await rm(dir, { recursive: true, force: true });
    await setScaleInProtection(false); // idle again — allow scale-in
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
