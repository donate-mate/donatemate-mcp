/**
 * Hermes FE Worker
 *
 * Long-polls the SQS jobs queue. Initial jobs create a clean work branch and open a PR. Follow-up
 * jobs clone the existing PR branch, address compact CI/review feedback, and push back to that
 * same branch. Results are written to DynamoDB + S3 and posted back to Slack/Jira.
 *
 * Run: `tsx src/index.ts` (containerized; image includes git + the `codex` CLI).
 */
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm as rmFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import {
  getInstallationAuth,
  commentOnPullRequest,
  replyToAddressedReviewComments,
  cloneRepo,
  createBranch,
  getHeadSha,
  hasChanges,
  commitAndPush,
  commitLocal,
  pushBranch,
  openPullRequest,
  ensurePullRequestLabels,
  prepareMergeConflictResolution,
  type MergeConflictPreparation,
} from './github.js';
import { ContainerRestartRequiredError, runAgent } from './agent.js';
import { installWorkspace } from './workspace.js';
import { runGate, gateSummary, type GateResult } from './gate.js';
import { loadContract, contractPromptBlock, validatePrBody, buildReportRepairPrompt, loadReport } from './contract.js';
import { runPreopenReview, buildReviewFixPrompt, reviewSummary } from './review.js';
import { reviewLearningPromptBlock } from './reviewLearning.js';
import { putMetric } from './metrics.js';
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
import { startScaleInProtectionRenewal } from './taskprotection.js';
import { findIssueKey, fetchIssueContext } from './jira.js';
import { commentOnIssue, transitionIssue, COLUMN, jiraIssueKey } from './jiraBot.js';
import { processQaProofJob } from './qaRunner.js';
import { processDeploymentVerificationJob } from './deployVerifier.js';
import { stagingDatabasePromptBlock } from './stagingDatabase.js';

const sqs = new SQSClient({});
const QUEUE = process.env.JOBS_QUEUE_URL!;
const WORKER_TYPE = process.env.WORKER_TYPE ?? 'fe';
const FRONTEND_DEPLOY_LABEL = 'deploy-dev';
const JOB_HEARTBEAT_SECONDS = Number(process.env.JOB_HEARTBEAT_SECONDS ?? 60);
const MESSAGE_VISIBILITY_SECONDS = Math.max(120, Number(process.env.MESSAGE_VISIBILITY_SECONDS ?? 15 * 60));
const MESSAGE_VISIBILITY_RENEW_SECONDS = Math.max(
  30,
  Math.min(Number(process.env.MESSAGE_VISIBILITY_RENEW_SECONDS ?? 5 * 60), Math.floor(MESSAGE_VISIBILITY_SECONDS / 2))
);
const JIRA_PROGRESS_HEARTBEAT_SECONDS = Math.max(60, Number(process.env.JIRA_PROGRESS_HEARTBEAT_SECONDS ?? 10 * 60));
const PRECOMMIT_REPAIR_ATTEMPTS = Number(process.env.PRECOMMIT_REPAIR_ATTEMPTS ?? 2);
const GATE_MAX_RETRIES = Number(process.env.GATE_MAX_RETRIES ?? 3); // WS2
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

/** Keep the SQS lease alive while a long coding/validation job is making progress. */
function startMessageVisibilityHeartbeat(receiptHandle: string): () => void {
  let stopped = false;
  let renewing = false;
  const interval = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: QUEUE,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: MESSAGE_VISIBILITY_SECONDS,
        })
      )
      .catch((err) =>
        console.warn('[sqs] failed to renew job visibility:', err instanceof Error ? err.message : String(err))
      )
      .finally(() => {
        renewing = false;
      });
  }, MESSAGE_VISIBILITY_RENEW_SECONDS * 1000);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
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

async function bestEffortFailureReport<T>(
  jobId: string,
  label: string,
  operation: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (reportError) {
    console.error(
      `[${jobId}] failure reporting step "${label}" failed:`,
      reportError instanceof Error ? reportError.message : String(reportError)
    );
    return undefined;
  }
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

/**
 * WS2 — run the pre-commit gate, feeding failures back into fresh Codex repair rounds up to
 * GATE_MAX_RETRIES. Returns the final gate result (may still be failing → caller opens fail-open,
 * never blocks forever). Emits HermesGateCycles / HermesGateFailShipped.
 */
async function runGateLoop(input: {
  jobId: string;
  dir: string;
  baseSha: string;
  installOk: boolean;
  type?: string;
  ticket?: string;
  onTranscript: (chunk: string) => void;
}): Promise<GateResult> {
  let phase = 'starting scoped validation';
  let jiraHeartbeatPending = false;
  const progress = async (message: string) => {
    phase = message.slice(0, 500);
    console.log(`[${input.jobId}] gate: ${message}`);
    await updateJob(input.jobId, 'running', { phase: `validation: ${message}`.slice(0, 500) }).catch((err) =>
      console.warn(`[${input.jobId}] failed to persist gate progress:`, err instanceof Error ? err.message : String(err))
    );
  };

  if (input.ticket) {
    await commentOnIssue(
      input.ticket,
      `🧪 Code changes are complete for job \`${input.jobId}\`. I’m running scoped formatting, lint, build, and test validation now. Long checks will receive progress heartbeats here.`
    );
  }
  const jiraHeartbeat = input.ticket
    ? setInterval(() => {
        if (jiraHeartbeatPending) return;
        jiraHeartbeatPending = true;
        commentOnIssue(input.ticket!, `⏳ Validation is still active for job \`${input.jobId}\`: ${phase}.`)
          .catch(() => {})
          .finally(() => {
            jiraHeartbeatPending = false;
          });
      }, JIRA_PROGRESS_HEARTBEAT_SECONDS * 1000)
    : undefined;
  jiraHeartbeat?.unref();

  try {
    let gate = await runGate(input.dir, input.baseSha, input.installOk, progress);
    let cycles = 0;
    while (!gate.ok && cycles < GATE_MAX_RETRIES) {
      cycles++;
      phase = `repairing validation failures (round ${cycles}/${GATE_MAX_RETRIES})`;
      console.warn(`[${input.jobId}] gate failed (${gateSummary(gate)}); repair round ${cycles}/${GATE_MAX_RETRIES}`);
      const repair = await runAgent(input.dir, ['The pre-commit gate is failing on the packages you changed.', '', gate.report].join('\n'));
      input.onTranscript(`\n--- Gate repair round ${cycles} ---\n${repair.transcript || `(exit ${repair.exitCode})`}`);
      gate = await runGate(input.dir, input.baseSha, input.installOk, progress);
    }
    await putMetric('HermesGateCycles', cycles, { type: input.type });
    if (!gate.ok) {
      await putMetric('HermesGateFailShipped', 1, { type: input.type });
      console.warn(`[${input.jobId}] gate still failing after ${cycles} rounds; opening PR fail-open`);
    }
    return gate;
  } finally {
    if (jiraHeartbeat) clearInterval(jiraHeartbeat);
  }
}

/** Assemble the initial-PR body: task, outcome report, gate + review sections, warnings. */
function assemblePrBody(input: {
  jobId: string;
  source: string;
  prompt: string;
  exitCode: number;
  transcriptUri: string;
  report?: string;
  reportIncomplete?: string[];
  gate: GateResult;
  reviewText?: string;
}): string {
  const parts: string[] = [
    `Automated PR by **Hermes** (job \`${input.jobId}\`, source: ${input.source}).`,
    '',
    '**Task**',
    `> ${input.prompt}`,
  ];
  if (input.report) {
    parts.push('', '---', '', input.report);
  }
  if (input.reportIncomplete?.length) {
    parts.push('', `> ⚠️ **Incomplete report** — missing required section(s): ${input.reportIncomplete.join(', ')}.`);
  }
  parts.push('', '---', '', `**Pre-commit gate:** ${gateSummary(input.gate)}`);
  if (!input.gate.ok) {
    const failed = input.gate.checks.filter((c) => !c.ok);
    parts.push(
      '',
      '> ⚠️ **Gate failures shipped** — the following checks did not pass after repair attempts; review carefully before merge:',
      ...failed.map((c) => `> - \`${c.name}\``)
    );
  }
  if (input.reviewText) {
    parts.push('', '**Pre-open review**', '', input.reviewText);
  }
  parts.push('', `Agent exit code: ${input.exitCode}. Transcript: ${input.transcriptUri}`, '', '⚠️ Agent-generated — review before merge.');
  return parts.join('\n');
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
  if (job.reviewReplyTargets?.length) {
    const replies = await replyToAddressedReviewComments(octokit, job.repo, job.prNumber, job.reviewReplyTargets, headSha);
    console.log(
      `[${jobId}] acknowledged addressed review feedback (${replies.posted} posted, ${replies.alreadyPresent} already present)`
    );
  }
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
    const stopProtection = await startScaleInProtectionRenewal();
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
      await stopProtection();
    }
    return;
  }
  if (kind === 'qa_proof') {
    console.log(`[${jobId}] processing QA proof against ${job.repo}@${job.headSha ?? job.baseBranch}`);
    await updateJob(jobId, 'running');
    const stopHeartbeat = startJobHeartbeat(jobId);
    const stopProtection = await startScaleInProtectionRenewal();
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
      await stopProtection();
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
  const stopProtection = await startScaleInProtectionRenewal(); // don't let the autoscaler kill us mid-job

  const dir = await mkdtemp(join(tmpdir(), `hermes-${jobId}-`));
  try {
    const branch = isPrFollowup ? job.headBranch : `hermes/${jobId.slice(0, 8)}`;
    if (!branch) throw new Error('follow-up job missing headBranch');
    const initialAuth = await getInstallationAuth(job.repo);
    let octokit = initialAuth.octokit;
    await cloneRepo(initialAuth.token, job.repo, isPrFollowup ? branch : job.baseBranch, dir);
    if (!isPrFollowup) await createBranch(dir, branch);
    const baseSha = await getHeadSha(dir); // baseline to detect agent commits, not just dirty tree
    let gateBaseSha = baseSha;

    let mergePrep: MergeConflictPreparation | undefined;
    if (isMergeConflictFollowup) {
      mergePrep = await prepareMergeConflictResolution(dir, job.baseBranch);
      // Validate the resolved PR tree against the current base branch. Using the old PR head here
      // includes every incoming base-branch file in the gate and caused backend-wide rebuilds.
      gateBaseSha = mergePrep.baseSha;
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

    // WS1 — install dependencies + generate the Prisma client so the agent and the pre-commit gate
    // can actually run jest/typecheck (a bare clone has no node_modules).
    const install = await installWorkspace(dir);
    if (install.durationMs) await putMetric('HermesInstallSeconds', Math.round(install.durationMs / 1000), { type: job.type });
    if (!install.ok && !install.skipped) console.warn(`[${jobId}] workspace install degraded:\n${install.log.slice(-800)}`);

    // WS3.2 — inject the repo-versioned contract (HERMES.md) verbatim as authoritative guidance.
    const contract = await loadContract(dir);

    // If the task references a Jira issue, pull its context so the agent builds the right thing.
    let prompt = job.prompt;
    let jiraContext: string | undefined;
    const issueKey = ticket ?? findIssueKey(`${job.source} ${job.prompt}`);
    if (issueKey) {
      const ctx = await fetchIssueContext(issueKey);
      if (ctx) {
        console.log(`[${jobId}] enriched prompt with Jira ${issueKey}`);
        jiraContext = ctx;
        prompt = `Context from ${ctx}\n\n---\n\nTask:\n${job.prompt}`;
      }
    }
    if (mergePrep?.status === 'conflicted') {
      prompt = `${prompt}\n\n---\n\nMerge conflict resolution context:\n${mergeConflictPrompt(job.baseBranch, mergePrep)}`;
    }

    // Retrieve only accepted, repo-scoped review lessons that overlap this task. The lookup is
    // bounded and fail-open, and replaces the broad external KB query on the critical startup path.
    const reviewMemory = await reviewLearningPromptBlock({
      repo: job.repo,
      type: job.type,
      queryText: `${job.prompt} ${jiraContext ?? ''} ${job.feedbackSummary ?? ''}`,
      currentPrNumber: job.prNumber,
    });
    console.log(
      `[${jobId}] review-memory lookup selected ${reviewMemory.lessonIds.length} lesson(s) in ${reviewMemory.lookupMs}ms`
    );
    if (reviewMemory.lessonIds.length) {
      console.log(
        `[${jobId}] injected accepted review lessons: ${reviewMemory.lessonIds.join(', ')}`
      );
    }
    const stagingDbBlock = stagingDatabasePromptBlock(job.type, issueKey ?? undefined);
    // WS3.3 — ask for the six-section outcome report up front (initial PRs only) to avoid an extra round.
    const reportInstruction = isPrFollowup
      ? ''
      : '\n\n--- OUTCOME REPORT ---\nWhen the change is complete, ALSO write an outcome report to a file named HERMES_REPORT.md at the repo root, with a level-2 Markdown heading for EACH section: Root cause, Evidence, Verification, Blast radius, Data repair, Deferred. The harness reads this into the PR description. Do not commit or push it.';
    const agentPrompt =
      [
        contract ? contractPromptBlock(contract) : undefined,
        reviewMemory.block || undefined,
        stagingDbBlock || undefined,
        prompt,
      ]
        .filter(Boolean)
        .join('\n\n') +
      reportInstruction;

    const agentRun = await runAgent(dir, agentPrompt);
    const exitCode = agentRun.exitCode;
    const reason = agentRun.reason;
    let transcript = agentRun.transcript;
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

    // WS2 — pre-commit gate: lint/format/tests on the changed packages, repairing via Codex up to
    // GATE_MAX_RETRIES. Fail-open: after the retries, still open the PR (with a loud warning).
    const installOk = install.skipped || install.ok;
    let gate = await runGateLoop({
      jobId,
      dir,
      baseSha: gateBaseSha,
      installOk,
      type: job.type,
      ticket: ticket ?? undefined,
      onTranscript: (c) => (transcript += c),
    });
    transcriptUri = await storeTranscript(jobId, transcript);

    if (isPrFollowup) {
      // Follow-up jobs push straight back to the PR branch; the post-open reconcile loop is unchanged.
      transcriptUri = await commitAndPushWithPrecommitRepair({ jobId, dir, branch, message: title, taskPrompt: prompt, transcript });
      const headSha = await getHeadSha(dir);
      if (!job.prNumber || !job.prUrl) throw new Error('follow-up job missing prNumber/prUrl');
      // Installation tokens expire after roughly one hour. Validation and review-repair rounds can
      // legitimately exceed that, so never reuse the client minted before clone for final API writes.
      octokit = (await getInstallationAuth(job.repo)).octokit;
      // Apply any labels the agent explicitly requested via a `HERMES-APPLY-LABEL: <label>` line in
      // its final message (e.g. `skip-openapi-sync` when it determines the change is a pure refactor
      // with no API-contract change). Best-effort.
      const requestedLabels = [...(agentRun.finalMessage ?? '').matchAll(/HERMES-APPLY-LABEL:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
      if (requestedLabels.length) {
        await ensurePullRequestLabels(octokit, job.repo, job.prNumber, requestedLabels).catch((e) =>
          console.warn(`[${jobId}] failed to apply requested labels:`, e instanceof Error ? e.message : String(e))
        );
        console.log(`[${jobId}] applied agent-requested labels: ${requestedLabels.join(', ')}`);
      }
      if (job.reviewReplyTargets?.length) {
        const replies = await replyToAddressedReviewComments(octokit, job.repo, job.prNumber, job.reviewReplyTargets, headSha);
        console.log(
          `[${jobId}] acknowledged addressed review feedback (${replies.posted} posted, ${replies.alreadyPresent} already present)`
        );
      }
      await putMetric('HermesCiFixAttempts', 1, { type: job.type }); // WS2 — post-open auto-repair round
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

    // ---- Initial PR: commit locally → WS4 adversarial review → WS3.3 body validation → push ----
    await commitLocal(dir, title);

    // WS4 — pre-open adversarial review (reasoning HIGH). BLOCKING findings → one fix round → re-gate.
    let reviewText: string | undefined;
    const review = await runPreopenReview({ dir, baseSha, ticketContext: jiraContext, contract });
    if (review.ran) {
      await putMetric('HermesPreopenFindings', review.findings.length, { type: job.type });
      const blocking = review.findings.filter((f) => f.severity === 'BLOCKING');
      await putMetric('HermesPreopenBlocking', blocking.length, { type: job.type });
      let fixed = 0;
      if (blocking.length) {
        const fix = await runAgent(dir, buildReviewFixPrompt(review.findings));
        transcript += `\n--- Pre-open review fix round ---\n${fix.transcript || `(exit ${fix.exitCode})`}`;
        gate = await runGateLoop({
          jobId,
          dir,
          baseSha: gateBaseSha,
          installOk,
          type: job.type,
          ticket: ticket ?? undefined,
          onTranscript: (c) => (transcript += c),
        });
        if (await hasChanges(dir, await getHeadSha(dir))) {
          await commitLocal(dir, `[hermes] address pre-open review (${jobId.slice(0, 8)})`);
          fixed = blocking.length;
        }
      }
      reviewText = reviewSummary(review.findings, fixed, review.findings.length - fixed);
    }

    // WS3.3 — ensure the six-section outcome report exists; one repair round, then open fail-open.
    let report = await loadReport(dir);
    const bodyCheck = validatePrBody(report ?? '');
    if (!bodyCheck.ok) {
      const rep = await runAgent(dir, buildReportRepairPrompt(bodyCheck.missing, contract));
      transcript += `\n--- Outcome report repair round ---\n${rep.transcript || `(exit ${rep.exitCode})`}`;
      report = (await loadReport(dir)) ?? report;
    }
    // Keep HERMES_REPORT.md out of the committed diff — its content is folded into the PR body.
    await rmFile(joinPath(dir, 'HERMES_REPORT.md')).catch(() => {});
    if (await hasChanges(dir, await getHeadSha(dir))) {
      await commitLocal(dir, `[hermes] outcome report follow-through (${jobId.slice(0, 8)})`);
    }
    const finalBodyCheck = validatePrBody(report ?? '');
    const reportIncomplete = finalBodyCheck.ok ? undefined : finalBodyCheck.missing;

    transcriptUri = await storeTranscript(jobId, transcript);
    await pushBranch(dir, branch);
    const headSha = await getHeadSha(dir);
    const body = assemblePrBody({
      jobId,
      source: job.source,
      prompt: job.prompt,
      exitCode,
      transcriptUri,
      report,
      reportIncomplete,
      gate,
      reviewText,
    });

    // Long-running validation can outlive the installation token created before clone. Git pushes
    // refresh their own remote token; refresh Octokit independently before PR creation.
    octokit = (await getInstallationAuth(job.repo)).octokit;
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
    const failureLogUri =
      msg.length > compactMsg.length
        ? await bestEffortFailureReport(jobId, 'store transcript', () => storeTranscript(jobId, msg))
        : undefined;
    console.error(`[${jobId}] failed:`, msg);
    await bestEffortFailureReport(jobId, 'update job', () =>
      updateJob(jobId, 'failed', {
        error: compactMsg,
        ...(failureLogUri ? { failureLogUri } : {}),
      })
    );
    await bestEffortFailureReport(jobId, 'notify', () =>
      notify(job, `:x: Hermes job \`${jobId}\` failed: ${compactText(msg, 1200)}`)
    );
    if (ticket) {
      await bestEffortFailureReport(jobId, 'comment on Jira issue', () =>
        commentOnIssue(
          ticket,
          formatFailureComment({
            jobId,
            message: msg,
            transcriptUri: failureLogUri,
            action: 'Moving back to **To Do**.',
          })
        )
      );
      await bestEffortFailureReport(jobId, 'transition Jira issue', () => transitionIssue(ticket, COLUMN.toDo));
      await bestEffortFailureReport(jobId, 'mark flow done', () =>
        markFlowDone(ticket, { flowError: msg.slice(0, 200) })
      );
    }
    // Preserve the original classification even if every best-effort reporting operation fails.
    // ContainerRestartRequiredError must reach loop() so the container exits before SQS redelivery.
    throw err; // do not delete the SQS message → redelivery, then DLQ
  } finally {
    stopHeartbeat();
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (cleanupError) {
      // A workspace is unique to this task and disappears with the Fargate container. Cleanup must
      // never turn an already-terminal job into an SQS redelivery (or mask its original failure).
      console.warn(
        `[${jobId}] workspace cleanup failed; leaving it for container teardown:`,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      );
    }
    try {
      await stopProtection(); // idle again — allow scale-in even if temp cleanup fails
    } catch (protectionError) {
      // The initial lease is bounded. Reporting a release failure is safer than duplicating a job
      // whose durable terminal state and external writes have already completed.
      console.warn(
        `[${jobId}] failed to release task protection:`,
        protectionError instanceof Error ? protectionError.message : String(protectionError)
      );
    }
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
        VisibilityTimeout: MESSAGE_VISIBILITY_SECONDS,
      })
    );
    for (const m of res.Messages ?? []) {
      const stopVisibilityHeartbeat = m.ReceiptHandle
        ? startMessageVisibilityHeartbeat(m.ReceiptHandle)
        : () => {};
      try {
        const { jobId } = JSON.parse(m.Body || '{}') as { jobId?: string };
        if (jobId) await processJob(jobId);
        stopVisibilityHeartbeat();
        await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE, ReceiptHandle: m.ReceiptHandle! }));
      } catch (err) {
        // Leave the message un-deleted → SQS redelivers up to maxReceiveCount, then DLQ.
        console.error('job processing error (will retry / DLQ):', err);
        // A timed-out command may have deliberately escaped the Codex process group. processJob
        // has already recorded the failure, cleaned the workspace, and released task protection;
        // exit this container so ECS removes any last escaped process before SQS redelivery.
        if (err instanceof ContainerRestartRequiredError) throw err;
      } finally {
        stopVisibilityHeartbeat();
      }
    }
  }
}

loop().catch((err) => {
  console.error('worker crashed:', err);
  process.exit(1);
});
