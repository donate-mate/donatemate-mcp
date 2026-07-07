/**
 * Deterministic PR verification loop. GitHub webhooks and periodic reconciliation are reduced to
 * compact CI/review signals. Only new actionable signals enqueue a short follow-up coding job.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { createJob, getJob, updateJob, type HermesJob, type JobKind } from './jobs.js';
import {
  collectPrSnapshot,
  ensurePullRequestLabels,
  latestSuccessfulWorkflowSignalContainingCommit,
  latestWorkflowSignalForCommit,
  listPullRequestChangedFiles,
  listRepositoryPaths,
  signalFromPrCommentWebhook,
  signalFromReviewWebhook,
  verifyGitHubSignature,
  type WorkflowRunSummary,
} from './github.js';
import {
  clearActiveFix,
  appendHandledSignals,
  getPrWatch,
  listActivePrWatches,
  listBlockedPrWatches,
  markWatchBlocked,
  markWatchQaQueued,
  markWatchReady,
  rememberGitHubDelivery,
  tryStartFix,
  updateWatchHead,
  type JiraState,
  type PrSignal,
  type PrWatch,
} from './prWatch.js';
import { commentOnIssue, transitionIssue, COLUMN } from './jiraBot.js';
import { postSlackMessage } from './slack.js';
import { getFlow, setFlow } from './jiraflow.js';
import { fetchIssueContext } from './jira.js';
import { loadQaScenarioCatalog } from './qaConfluence.js';
import { buildQaProofPlan, buildQaReadinessPlan, summarizeQaPlan, type QaProofPlan } from './qaPlanner.js';

// Per-PR cap on distinct automated fix rounds. Note fixAttemptCount only increments on NEW,
// de-duplicated signals (a given CI failure / review is addressed once), so this is effectively
// a budget of distinct problems, not retries of the same one. Raised 4→8 so active PRs that
// accumulate several rounds of CI/review feedback aren't prematurely benched.
const MAX_FIX_ATTEMPTS = Number(process.env.PR_MONITOR_MAX_FIX_ATTEMPTS ?? 8);
const STALE_FIX_SECONDS = Number(process.env.PR_MONITOR_STALE_FIX_SECONDS ?? 45 * 60);
const FRONTEND_DEPLOY_LABEL = 'deploy-dev';
const BACKEND_DEPLOY_WORKFLOW_ID = process.env.BE_DEPLOY_WORKFLOW_ID || '208630294';
const FRONTEND_BUILD_WORKFLOW_ID = process.env.QA_BUILD_WORKFLOW_ID || 'staging.yml';
const QA_AUTOMATION_ENABLED = /^(1|true|yes)$/i.test(process.env.QA_AUTOMATION_ENABLED ?? 'false');

function compact(value: string, max = 900): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatSignals(signals: PrSignal[], maxDetails = 900): string {
  return signals
    .slice(0, 12)
    .map((s) => {
      const details = s.details ? `\n  ${compact(s.details, maxDetails)}` : '';
      const url = s.url ? `\n  ${s.url}` : '';
      const label = s.kind === 'ci_failed' ? 'CI' : s.kind === 'merge_conflict' ? 'merge conflict' : 'review';
      return `- [${label}] ${s.summary}${details}${url}`;
    })
    .join('\n');
}

function dedupeNewSignals(watch: PrWatch, signals: PrSignal[]): PrSignal[] {
  const handled = new Set(watch.handledSignalIds ?? []);
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (handled.has(signal.id) || seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  });
}

function followupKind(signals: PrSignal[]): { kind: JobKind; jiraState: JiraState } {
  const allCi = signals.every((s) => s.kind === 'ci_failed');
  const allReview = signals.every((s) => s.kind === 'review_feedback');
  const hasMergeConflict = signals.some((s) => s.kind === 'merge_conflict');
  if (hasMergeConflict) return { kind: 'merge_conflict_fix', jiraState: 'fixing_merge_conflict' };
  if (allCi) return { kind: 'ci_fix', jiraState: 'fixing_ci' };
  if (allReview) return { kind: 'review_fix', jiraState: 'fixing_review' };
  return { kind: 'combined_followup', jiraState: 'fixing_review' };
}

function isRecoverableDeploymentBlock(watch: PrWatch): boolean {
  const reason = String(watch.blockReason ?? '');
  return (
    watch.status === 'prwatch:blocked' &&
    watch.jiraState === 'qa_failed' &&
    !watch.activeQaJobId &&
    /(?:test build|deployment) workflow .* concluded|deployment workflow did not complete/i.test(reason)
  );
}

async function recoveryWorkflowSignal(watch: PrWatch, mergeCommitSha: string, log: FastifyBaseLogger): Promise<WorkflowRunSummary | null> {
  if (!isRecoverableDeploymentBlock(watch)) return null;
  const workflowId = watch.type === 'fe' ? FRONTEND_BUILD_WORKFLOW_ID : BACKEND_DEPLOY_WORKFLOW_ID;
  const exactSignal = await latestWorkflowSignalForCommit(watch.repo, workflowId, mergeCommitSha, watch.baseBranch).catch((err) => {
    log.warn({ err, repo: watch.repo, prNumber: watch.prNumber, workflowId, mergeCommitSha }, 'failed to inspect blocked deployment signal');
    return null;
  });
  log.info(
    { repo: watch.repo, prNumber: watch.prNumber, workflowId, mergeCommitSha, signal: exactSignal },
    'checked exact blocked deployment watch for recovery'
  );
  if (exactSignal?.status === 'completed' && exactSignal.conclusion === 'success') return exactSignal;

  const branchSignal = await latestSuccessfulWorkflowSignalContainingCommit(watch.repo, workflowId, mergeCommitSha, watch.baseBranch).catch((err) => {
    log.warn(
      { err, repo: watch.repo, prNumber: watch.prNumber, workflowId, mergeCommitSha, baseBranch: watch.baseBranch },
      'failed to inspect branch deployment recovery signal'
    );
    return null;
  });
  log.info(
    { repo: watch.repo, prNumber: watch.prNumber, workflowId, mergeCommitSha, baseBranch: watch.baseBranch, signal: branchSignal },
    'checked branch deployment watch for recovery'
  );
  return branchSignal;
}

function buildFollowupPrompt(watch: PrWatch, signals: PrSignal[], feedbackSummary: string): string {
  return [
    `You are updating an existing Hermes PR branch, not starting a new task.`,
    '',
    `PR: ${watch.prUrl}`,
    `Repository: ${watch.repo}`,
    `Base branch: ${watch.baseBranch}`,
    `PR branch: ${watch.headBranch}`,
    watch.issueKey ? `Jira issue: ${watch.issueKey}` : undefined,
    '',
    'Original task:',
    watch.originalPrompt,
    '',
    'Address ONLY the new CI/review/merge-conflict feedback below. Keep the fix scoped, preserve unrelated code, and do not broaden the original PR.',
    '',
    feedbackSummary,
    '',
    'Before finishing, run the narrowest relevant local validation you can infer from the changed files. If validation cannot run locally, mention that in your final message.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function markFlowDoneIfPresent(issueKey: string, extra: Partial<{ prUrl: string; flowError: string }> = {}): Promise<void> {
  const flow = await getFlow(issueKey);
  if (!flow) return;
  await setFlow(issueKey, { ...flow, status: 'done', ...extra });
}

async function notifyThread(watch: PrWatch, text: string): Promise<void> {
  if (watch.channel) await postSlackMessage(watch.channel, text, watch.threadTs);
}

async function ensureFrontendDeployLabel(watch: PrWatch, log: FastifyBaseLogger): Promise<void> {
  if (watch.type !== 'fe') return;
  await ensurePullRequestLabels(watch.repo, watch.prNumber, [FRONTEND_DEPLOY_LABEL]).catch((err) =>
    log.warn({ err, repo: watch.repo, prNumber: watch.prNumber, label: FRONTEND_DEPLOY_LABEL }, 'failed to ensure frontend PR deploy label')
  );
}

async function blockWatch(watch: PrWatch, reason: string): Promise<void> {
  if (!(await markWatchBlocked(watch, reason))) return;
  if (watch.issueKey) {
    await commentOnIssue(
      watch.issueKey,
      `⚠️ Hermes stopped automated PR repair for ${watch.prUrl}.\n\nReason: ${reason}\n\nA human should review the PR and decide the next step.`
    );
    await transitionIssue(watch.issueKey, COLUMN.blocked);
    await markFlowDoneIfPresent(watch.issueKey, { prUrl: watch.prUrl, flowError: reason.slice(0, 200) });
  }
  await notifyThread(watch, `:warning: Hermes stopped automated PR repair for ${watch.prUrl}: ${reason}`);
}

async function startFollowupJob(watch: PrWatch, signals: PrSignal[]): Promise<void> {
  const nextAttempt = (watch.fixAttemptCount ?? 0) + 1;
  if (nextAttempt > MAX_FIX_ATTEMPTS) {
    await blockWatch(watch, `maximum automated fix attempts reached (${MAX_FIX_ATTEMPTS})`);
    return;
  }

  const signalIds = signals.map((s) => s.id);
  const { kind, jiraState } = followupKind(signals);
  const feedbackSummary = formatSignals(signals);
  const fixJobId = randomUUID();
  const reserved = await tryStartFix(watch, fixJobId, jiraState, nextAttempt);
  if (!reserved) return;

  try {
    const job = await createJob({
      jobId: fixJobId,
      kind,
      type: watch.type,
      repo: watch.repo,
      baseBranch: watch.baseBranch,
      headBranch: watch.headBranch,
      headSha: watch.headSha,
      prNumber: watch.prNumber,
      prUrl: watch.prUrl,
      issueKey: watch.issueKey,
      parentJobId: watch.sourceJobId,
      channel: watch.channel,
      threadTs: watch.threadTs,
      feedbackSummary,
      source: `github:${watch.repo}#${watch.prNumber}`,
      prompt: buildFollowupPrompt(watch, signals, feedbackSummary),
    });
    await appendHandledSignals(watch, signalIds);
    const message = [
      `Hermes detected new PR feedback on ${watch.prUrl}.`,
      '',
      `Starting automated fix attempt ${nextAttempt}/${MAX_FIX_ATTEMPTS} (job \`${job.jobId}\`).`,
      '',
      feedbackSummary,
    ].join('\n');
    if (watch.issueKey) {
      await commentOnIssue(watch.issueKey, message);
      await transitionIssue(watch.issueKey, COLUMN.inProgress);
    }
    await notifyThread(watch, `:hammer_and_wrench: ${message}`);
  } catch (err) {
    await clearActiveFix(watch, fixJobId);
    throw err;
  }
}

function jobUpdatedAt(job: HermesJob): string | undefined {
  return job.updatedAt ?? job.createdAt;
}

function ageSeconds(iso?: string): number {
  const millis = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(millis)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - millis) / 1000));
}

async function recoverStaleActiveFix(watch: PrWatch, log: FastifyBaseLogger): Promise<PrWatch | null> {
  if (watch.status !== 'prwatch:fixing' || !watch.activeFixJobId) return watch;

  const fixJobId = watch.activeFixJobId;
  const job = await getJob(fixJobId);
  const jobAgeSeconds = job ? ageSeconds(jobUpdatedAt(job)) : Number.POSITIVE_INFINITY;
  const terminal = job?.status === 'done' || job?.status === 'failed';
  const stale = !job || terminal || jobAgeSeconds >= STALE_FIX_SECONDS;

  if (!stale) {
    log.info(
      { repo: watch.repo, prNumber: watch.prNumber, activeFixJobId: fixJobId, jobStatus: job?.status, jobAgeSeconds },
      'PR already has an active fix job'
    );
    return null;
  }

  const reason = !job
    ? 'active fix job row is missing'
    : terminal
      ? `active fix job is already ${job.status}`
      : `active fix job heartbeat is stale (${jobAgeSeconds}s old)`;

  log.warn({ repo: watch.repo, prNumber: watch.prNumber, activeFixJobId: fixJobId, reason }, 'recovering stale active PR fix job');

  if (job && job.status !== 'done' && job.status !== 'failed') {
    await updateJob(fixJobId, 'failed', {
      error: `stale active PR fix recovered by monitor: ${reason}`,
    });
  }
  await clearActiveFix(watch, fixJobId);

  const creditInfrastructureAttempt = !job || (job.status !== 'done' && job.status !== 'failed');
  return {
    ...watch,
    status: 'prwatch:watching',
    activeFixJobId: '',
    fixAttemptCount: creditInfrastructureAttempt ? Math.max(0, (watch.fixAttemptCount ?? 0) - 1) : (watch.fixAttemptCount ?? 0),
  };
}

async function startPostMergeQa(watch: PrWatch, mergeCommitSha: string, recoveryRun?: WorkflowRunSummary | null): Promise<void> {
  const qaJobId = randomUUID();
  const reserved = await markWatchQaQueued(watch, qaJobId, mergeCommitSha);
  if (!reserved) return;

  try {
    const buildHeadSha = recoveryRun?.headSha && recoveryRun.headSha !== mergeCommitSha ? recoveryRun.headSha : undefined;
    const buildRunUrl = recoveryRun?.htmlUrl ?? undefined;
    let plan: QaProofPlan;
    if (QA_AUTOMATION_ENABLED) {
      const [changedFiles, repoPaths, catalog, issueText] = await Promise.all([
        listPullRequestChangedFiles(watch.repo, watch.prNumber).catch(() => []),
        listRepositoryPaths(watch.repo, mergeCommitSha).catch(() => []),
        loadQaScenarioCatalog(),
        watch.issueKey ? fetchIssueContext(watch.issueKey).catch(() => null) : Promise.resolve(null),
      ]);

      plan = buildQaProofPlan({
        watch,
        mergeCommitSha,
        buildHeadSha,
        buildRunUrl,
        changedFiles,
        repoPaths,
        issueText: issueText ?? undefined,
        catalog,
      });
    } else {
      plan = buildQaReadinessPlan({
        watch,
        mergeCommitSha,
        buildHeadSha,
        buildRunUrl,
      });
    }

    const prompt = JSON.stringify(plan, null, 2);
    const job = await createJob({
      jobId: qaJobId,
      kind: 'qa_proof',
      type: 'qa',
      repo: watch.repo,
      baseBranch: watch.baseBranch,
      headSha: mergeCommitSha,
      prNumber: watch.prNumber,
      prUrl: watch.prUrl,
      issueKey: watch.issueKey,
      parentJobId: watch.sourceJobId,
      channel: watch.channel,
      threadTs: watch.threadTs,
      source: `github:${watch.repo}#${watch.prNumber}:merge`,
      prompt,
    });

    const summary = summarizeQaPlan(plan);
    const qaLabel = plan.automationDisabled ? 'post-merge readiness' : 'post-merge QA proof';
    if (watch.issueKey) {
      await commentOnIssue(
        watch.issueKey,
        [
          `✅ PR merged: ${watch.prUrl}`,
          '',
          `Waiting for deployment workflow \`${plan.build.workflowId}\` on \`${plan.baseBranch}\` before moving to Ready for QA.`,
          `Merge commit: \`${mergeCommitSha}\``,
          plan.build.headSha && plan.build.headSha !== mergeCommitSha ? `Recovered by branch build: \`${plan.build.headSha}\`` : undefined,
          plan.build.runUrl ? `Build workflow: ${plan.build.runUrl}` : undefined,
          '',
          `🧪 ${qaLabel[0].toUpperCase()}${qaLabel.slice(1)} job queued: \`${job.jobId}\`.`,
          '',
          summary,
        ].filter(Boolean).join('\n')
      );
    }
    await notifyThread(watch, `:test_tube: Hermes queued ${qaLabel} for ${watch.prUrl} (job ${job.jobId}).`);
  } catch (err) {
    const reason = `failed to queue post-merge readiness: ${err instanceof Error ? err.message : String(err)}`;
    await blockWatch(watch, reason);
    throw err;
  }
}

async function startPostMergeDeploymentVerification(watch: PrWatch, mergeCommitSha: string, recoveryRun?: WorkflowRunSummary | null): Promise<void> {
  const deployJobId = randomUUID();
  const reserved = await markWatchQaQueued(watch, deployJobId, mergeCommitSha);
  if (!reserved) return;

  const plan = {
    version: 1,
    mode: 'post_merge_deployment',
    createdAt: new Date().toISOString(),
    repo: watch.repo,
    prNumber: watch.prNumber,
    prUrl: watch.prUrl,
    mergeCommitSha,
    baseBranch: watch.baseBranch,
    issueKey: watch.issueKey || undefined,
    deployment: {
      workflowId: BACKEND_DEPLOY_WORKFLOW_ID,
      branch: watch.baseBranch,
      headSha: recoveryRun?.headSha && recoveryRun.headSha !== mergeCommitSha ? recoveryRun.headSha : undefined,
      runUrl: recoveryRun?.htmlUrl ?? undefined,
      recoveredFromMergeCommitSha: recoveryRun?.headSha && recoveryRun.headSha !== mergeCommitSha ? mergeCommitSha : undefined,
    },
  };

  const job = await createJob({
    jobId: deployJobId,
    kind: 'deploy_verification',
    type: watch.type,
    repo: watch.repo,
    baseBranch: watch.baseBranch,
    headSha: mergeCommitSha,
    prNumber: watch.prNumber,
    prUrl: watch.prUrl,
    issueKey: watch.issueKey,
    parentJobId: watch.sourceJobId,
    channel: watch.channel,
    threadTs: watch.threadTs,
    source: `github:${watch.repo}#${watch.prNumber}:merge`,
    prompt: JSON.stringify(plan, null, 2),
  });

  if (watch.issueKey) {
    await commentOnIssue(
      watch.issueKey,
      [
        `✅ PR merged: ${watch.prUrl}`,
        '',
        `Waiting for deployment workflow \`${plan.deployment.workflowId}\` on \`${plan.baseBranch}\` before moving to Ready for QA.`,
        `Merge commit: \`${mergeCommitSha}\``,
        plan.deployment.headSha && plan.deployment.headSha !== mergeCommitSha ? `Recovered by branch deployment: \`${plan.deployment.headSha}\`` : undefined,
        plan.deployment.runUrl ? `Deployment workflow: ${plan.deployment.runUrl}` : undefined,
        `Deployment verification job: \`${job.jobId}\``,
      ].filter(Boolean).join('\n')
    );
  }
  await notifyThread(watch, `:rocket: Hermes queued post-merge deployment verification for ${watch.prUrl} (job ${job.jobId}).`);
}

export async function reconcilePrWatch(watch: PrWatch, log: FastifyBaseLogger, extraSignals: PrSignal[] = []): Promise<void> {
  let currentWatch = watch;
  const snapshot = await collectPrSnapshot(currentWatch, extraSignals);
  await updateWatchHead(currentWatch, snapshot.headSha, snapshot.headBranch, snapshot.prUrl);

  if (snapshot.state === 'MERGED') {
    const mergeCommitSha = snapshot.mergeCommitSha || snapshot.headSha;
    let recoveryRun: WorkflowRunSummary | null = null;
    if (currentWatch.status === 'prwatch:blocked') {
      recoveryRun = await recoveryWorkflowSignal(currentWatch, mergeCommitSha, log);
      if (!recoveryRun) return;
    }
    if (currentWatch.type === 'fe') {
      await startPostMergeQa(
        { ...currentWatch, prUrl: snapshot.prUrl, headSha: mergeCommitSha, headBranch: snapshot.headBranch },
        mergeCommitSha,
        recoveryRun
      );
      return;
    }

    await startPostMergeDeploymentVerification(
      { ...currentWatch, prUrl: snapshot.prUrl, headSha: mergeCommitSha, headBranch: snapshot.headBranch },
      mergeCommitSha,
      recoveryRun
    );
    return;
  }

  if (snapshot.state === 'CLOSED') {
    await blockWatch(currentWatch, `PR was closed before merge: ${snapshot.prUrl}`);
    return;
  }

  await ensureFrontendDeployLabel(currentWatch, log);

  const recoveredWatch = await recoverStaleActiveFix(currentWatch, log);
  if (!recoveredWatch) {
    return;
  }
  currentWatch = recoveredWatch;

  const actionable = dedupeNewSignals(currentWatch, snapshot.signals);
  if (actionable.length) {
    await startFollowupJob({ ...currentWatch, headSha: snapshot.headSha, headBranch: snapshot.headBranch, prUrl: snapshot.prUrl }, actionable);
    return;
  }

  const persistentMergeConflicts = snapshot.signals.filter((signal) => signal.kind === 'merge_conflict');
  if (persistentMergeConflicts.length) {
    await startFollowupJob(
      { ...currentWatch, headSha: snapshot.headSha, headBranch: snapshot.headBranch, prUrl: snapshot.prUrl },
      persistentMergeConflicts
    );
    return;
  }

  if (snapshot.ciState === 'passing') {
    const marked = await markWatchReady(currentWatch, snapshot.headSha);
    if (marked) {
      if (currentWatch.issueKey) {
        await commentOnIssue(
          currentWatch.issueKey,
          `✅ Hermes verified ${snapshot.prUrl}: CI is passing and there are no unresolved actionable review threads. Ready for human review.`
        );
        await transitionIssue(currentWatch.issueKey, COLUMN.codeReview);
      }
      await notifyThread(currentWatch, `:white_check_mark: Hermes verified ${snapshot.prUrl}: CI is passing and no unresolved review feedback is pending.`);
    }
  }
}

function payloadRepoAndPr(body: Record<string, any>): { repo?: string; prNumber?: number; extraSignals: PrSignal[] } {
  const repo = body.repository?.full_name as string | undefined;
  const prNumber =
    body.pull_request?.number ??
    body.issue?.number ??
    body.check_run?.pull_requests?.[0]?.number ??
    body.check_suite?.pull_requests?.[0]?.number ??
    body.workflow_run?.pull_requests?.[0]?.number;
  const extraSignals = [
    signalFromReviewWebhook(body),
    signalFromPrCommentWebhook(body),
  ].filter((s): s is PrSignal => Boolean(s));
  return { repo, prNumber: typeof prNumber === 'number' ? prNumber : undefined, extraSignals };
}

export async function handleGitHubWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, any>,
  log: FastifyBaseLogger
): Promise<{ ok: true; ignored?: string }> {
  if (!(await verifyGitHubSignature(rawBody, headers))) throw new Error('invalid GitHub signature');
  const deliveryId = String(headers['x-github-delivery'] ?? '');
  const firstDelivery = await rememberGitHubDelivery(deliveryId);
  if (!firstDelivery) return { ok: true, ignored: 'duplicate delivery' };

  const { repo, prNumber, extraSignals } = payloadRepoAndPr(body);
  if (!repo || !prNumber) return { ok: true, ignored: 'not a watched PR event' };
  const watch = await getPrWatch(repo, prNumber);
  if (!watch) return { ok: true, ignored: 'PR is not watched by Hermes' };
  await reconcilePrWatch(watch, log, extraSignals);
  return { ok: true };
}

export async function reconcileOpenPrs(log: FastifyBaseLogger): Promise<void> {
  const [active, blocked] = await Promise.all([listActivePrWatches(), listBlockedPrWatches()]);
  const watches = [...active, ...blocked.filter(isRecoverableDeploymentBlock)];
  for (const watch of watches) {
    await reconcilePrWatch(watch, log).catch((err) =>
      log.error({ err, repo: watch.repo, prNumber: watch.prNumber }, 'PR reconciliation failed')
    );
  }
}
