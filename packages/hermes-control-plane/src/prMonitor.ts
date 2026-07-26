/**
 * Deterministic PR verification loop. GitHub webhooks and periodic reconciliation are reduced to
 * compact CI/review signals. Only new actionable signals enqueue a short follow-up coding job.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  createJob,
  getJob,
  updateJob,
  type HermesJob,
  type JobKind,
  type ReviewReplyTarget,
} from './jobs.js';
import {
  collectPrBodyAndComments,
  collectPrSnapshot,
  commentOnPullRequest,
  ensurePullRequestLabels,
  isHermesCommit,
  isRateLimitError,
  latestSuccessfulWorkflowSignalContainingCommit,
  latestWorkflowSignalForCommit,
  listPullRequestChangedFiles,
  listRepositoryPaths,
  rebasePullRequestBranch,
  remainingRestBudget,
  requestReReviewFromChangeRequesters,
  reviewThreadResolutionFromWebhook,
  signalFromPrCommentWebhook,
  signalFromReviewWebhook,
  verifyGitHubSignature,
  type WorkflowRunSummary,
} from './github.js';
// --- WS5 ---
import { announceOverlaps, computeOverlaps } from './overlap.js';
import { evaluateChecklist, evaluateEvidence, extractEvidenceIds, renderChecklist } from './readiness.js';
import {
  clearActiveFix,
  clearWatchAssignmentPause,
  appendHandledSignals,
  getPrWatch,
  listActivePrWatches,
  listBlockedPrWatches,
  listReviewLearningBackfillWatches,
  hasCurrentReviewLearningCapture,
  seedLegacyReviewLearningCaptureRequests,
  markWatchBlocked,
  acquireReconcileLease,
  ensureReviewLearningCapturePending,
  markReviewLearningCaptured,
  markReviewLearningCaptureCompleted,
  recordReviewLearningCaptureFailure,
  markWatchQaQueued,
  markWatchReady,
  markReviewPinged,
  markWatchAssignmentPaused,
  rememberGitHubDelivery,
  tryStartFix,
  unblockWatch,
  updateWatchHead,
  type JiraState,
  type PrSignal,
  type PrWatch,
} from './prWatch.js';
import { commentOnIssue, transitionIssue, COLUMN, getBotAccountId } from './jiraBot.js';
import { postSlackMessage } from './slack.js';
import { getFlow, setFlow } from './jiraflow.js';
import { fetchIssueContext, getIssueAssigneeAccountId } from './jira.js';
import { loadQaScenarioCatalog } from './qaConfluence.js';
import { buildQaProofPlan, buildQaReadinessPlan, summarizeQaPlan, type QaProofPlan } from './qaPlanner.js';
import {
  recordMergedReviewLessons,
  recordReviewThreadResolutionEvidence,
} from './reviewLearning.js';

// Per-PR cap on automated fix rounds — of distinct problems AND of retries of a problem a previous
// attempt failed to resolve (see RETRY_UNRESOLVED_SIGNALS). Reaching it blocks the watch, which is
// visible and actionable; running out of retries silently is not.
const MAX_FIX_ATTEMPTS = Number(process.env.PR_MONITOR_MAX_FIX_ATTEMPTS ?? 8);
const STALE_FIX_SECONDS = Number(process.env.PR_MONITOR_STALE_FIX_SECONDS ?? 45 * 60);
// How long a fix job may sit *queued* (waiting for a worker slot) before we treat it as lost. Must
// exceed the worst-case queue wait, which is (queue depth ÷ workers) × job duration.
const QUEUED_FIX_GRACE_SECONDS = Number(process.env.PR_MONITOR_QUEUED_FIX_GRACE_SECONDS ?? 4 * 60 * 60);
// Retry a self-clearing signal (CI failure / merge conflict) that a previous attempt did not fix.
// See dedupeNewSignals. Off → the pre-existing "address each signal exactly once" behavior.
const RETRY_UNRESOLVED_SIGNALS = !/^(0|false|no|off)$/i.test(process.env.PR_MONITOR_RETRY_UNRESOLVED ?? 'true');
// Minimum gap between fix attempts on one PR, so a check that fails within seconds of a push cannot
// spin the fixer at the reconcile interval.
const FIX_RETRY_COOLDOWN_SECONDS = Number(process.env.PR_MONITOR_FIX_RETRY_COOLDOWN_SECONDS ?? 10 * 60);
// Re-request human review on a green PR whose reviewer left CHANGES_REQUESTED (once per head sha).
const REVIEW_REPING_ENABLED = !/^(0|false|no|off)$/i.test(process.env.PR_MONITOR_REVIEW_REPING ?? 'true');
const configuredReviewLearningRetryMs = Number(
  process.env.REVIEW_LEARNING_MERGE_RETRY_MS ?? 1500
);
const REVIEW_LEARNING_MERGE_RETRY_MS = Number.isFinite(configuredReviewLearningRetryMs)
  ? Math.max(250, configuredReviewLearningRetryMs)
  : 1500;
// Do not start a poll sweep with less than this much of the 5,000/hr installation REST budget left —
// webhook-driven reconciles and the fix jobs' own pushes/comments need headroom.
const RECONCILE_BUDGET_RESERVE = Number(process.env.PR_MONITOR_BUDGET_RESERVE ?? 500);
// Collapse a burst of check_run/workflow_run webhooks for one PR into a single reconcile.
const WEBHOOK_COALESCE_SECONDS = Number(process.env.PR_MONITOR_WEBHOOK_COALESCE_SECONDS ?? 45);
const recentWebhookReconciles = new Map<string, number>();
// Minimum gap between periodic sweeps across the whole control-plane fleet. Slightly under the timer
// interval so a little clock skew between replicas cannot skip a tick outright.
const RECONCILE_LEASE_SECONDS = Number(process.env.PR_MONITOR_RECONCILE_LEASE_SECONDS ?? 240);
const FRONTEND_DEPLOY_LABEL = 'deploy-dev';
const BACKEND_DEPLOY_WORKFLOW_ID = process.env.BE_DEPLOY_WORKFLOW_ID || '208630294';
const FRONTEND_BUILD_WORKFLOW_ID = process.env.QA_BUILD_WORKFLOW_ID || 'staging.yml';
const QA_AUTOMATION_ENABLED = /^(1|true|yes)$/i.test(process.env.QA_AUTOMATION_ENABLED ?? 'false');
// --- WS5 --- Control-plane orchestration gates (all default on; every path fails open).
const OVERLAP_COORDINATION_ENABLED = !/^(0|false|no|off)$/i.test(process.env.OVERLAP_COORDINATION_ENABLED ?? 'true');
const CHECKLIST_ENABLED = !/^(0|false|no|off)$/i.test(process.env.CHECKLIST_ENABLED ?? 'true');
const EVIDENCE_CHECK_ENABLED = !/^(0|false|no|off)$/i.test(process.env.EVIDENCE_CHECK_ENABLED ?? 'true');
// Stop making follow-up commits once a ticket is no longer assigned to Hermes; auto-unblock a
// blocked PR when a human pushes a new commit to it. Both default on, fail open.
const ASSIGNEE_GUARD_ENABLED = !/^(0|false|no|off)$/i.test(process.env.ASSIGNEE_GUARD_ENABLED ?? 'true');
const AUTO_UNBLOCK_ON_HUMAN_COMMIT = !/^(0|false|no|off)$/i.test(process.env.AUTO_UNBLOCK_ON_HUMAN_COMMIT ?? 'true');

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

/** Preserve exact inline-review locations through DynamoDB/SQS so the worker can reply in-thread. */
export function reviewReplyTargetsForSignals(signals: PrSignal[]): ReviewReplyTarget[] {
  const targets = new Map<string, ReviewReplyTarget>();
  for (const signal of signals) {
    if (
      signal.kind !== 'review_feedback' ||
      !signal.reviewThreadId ||
      !signal.reviewCommentId ||
      !Number.isSafeInteger(signal.reviewRootCommentId) ||
      Number(signal.reviewRootCommentId) <= 0
    ) {
      continue;
    }
    targets.set(signal.reviewCommentId, {
      threadId: signal.reviewThreadId,
      feedbackCommentId: signal.reviewCommentId,
      rootCommentId: Number(signal.reviewRootCommentId),
      url: signal.url,
    });
  }
  return [...targets.values()];
}

/**
 * A CI failure or a merge conflict is *self-clearing*: it vanishes from the snapshot the moment it
 * is actually fixed. Review feedback is not — a review thread stays unresolved, and `reviewDecision`
 * stays CHANGES_REQUESTED, until a human acts, so re-firing it would loop forever.
 */
const SELF_CLEARING: ReadonlySet<PrSignal['kind']> = new Set(['ci_failed', 'merge_conflict']);

/**
 * Which signals warrant a fix job right now.
 *
 * `handledSignalIds` is written when a fix job is *enqueued*, not when it succeeds — so a handled id
 * means "we tried", not "it's fixed". A CI signal's id embeds the head sha, so when an attempt fails
 * or produces no commit the head never moves and the still-failing check keeps producing the exact
 * same id — which is now permanently handled. That silently starved PRs of any further attempt (red,
 * `watching`, fix count far below the cap, untouched for days). So: a self-clearing signal that is
 * still present was, by definition, not resolved — retry it (bounded by the cooldown and the attempt
 * cap). Non-self-clearing signals keep the address-once semantics.
 */
export function dedupeNewSignals(watch: PrWatch, signals: PrSignal[]): PrSignal[] {
  const handled = new Set(watch.handledSignalIds ?? []);
  const cooling = ageSeconds(watch.lastFixAt) < FIX_RETRY_COOLDOWN_SECONDS;
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false;
    if (handled.has(signal.id)) {
      if (!RETRY_UNRESOLVED_SIGNALS || !SELF_CLEARING.has(signal.kind) || cooling) return false;
    }
    seen.add(signal.id);
    return true;
  });
}

/** True when we are re-attempting a signal an earlier fix job already claimed to have handled. */
export function isRetryOfHandledSignal(watch: PrWatch, signals: PrSignal[]): boolean {
  const handled = new Set(watch.handledSignalIds ?? []);
  return signals.some((signal) => handled.has(signal.id));
}

/**
 * Tell the agent that its previous attempt did not work, and why. Without this a retry tends to
 * repeat the same reasoning that produced no changes last time.
 */
async function retryContext(watch: PrWatch): Promise<string> {
  const previous = watch.lastFixJobId ? await getJob(watch.lastFixJobId).catch(() => null) : null;
  const outcome = String(previous?.error ?? '').trim();
  return [
    '--- THIS IS A RETRY — THE PREVIOUS FIX ATTEMPT DID NOT RESOLVE THIS ---',
    `A previous Hermes attempt (fix ${watch.fixAttemptCount ?? 0}/${MAX_FIX_ATTEMPTS}) already tried to address the feedback below and the check is STILL failing at the current head.`,
    outcome ? `That attempt ended: ${compact(outcome, 300)}` : 'That attempt ended without pushing a commit.',
    'Do not repeat that approach, and do not conclude that no change is needed — the failing check is',
    'objective proof that a change IS needed. Reproduce the failure locally, fix the underlying cause,',
    'and make sure you actually modify files and leave them staged for commit.',
  ].join('\n');
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

// Targeted remediation for the API contract-sync checks ("Enforce OpenAPI Sync" / "Contract drift
// (runtime ↔ OpenAPI ↔ SDK)"). These fail when API contract files change but packages/docs/openapi.yaml
// (+ the FE SDK) are not updated; the generic "address the feedback" prompt was not connecting the
// failure to that action, so PRs churned to the attempt cap without ever touching the spec.
function openApiRemediation(feedbackSummary: string): string {
  if (!/openapi|contract\s*drift|contract-drift|openapi\.yaml/i.test(feedbackSummary)) return '';
  return [
    '',
    '--- API CONTRACT-SYNC CHECK IS FAILING — THIS IS THE PRIORITY ---',
    'One of the failing checks is the API contract-sync check (e.g. "Enforce OpenAPI Sync" or',
    '"Contract drift (runtime ↔ OpenAPI ↔ SDK)"). It fails when API contract source files changed but',
    '`packages/docs/openapi.yaml` was not updated in this PR. Per HERMES.md §5 you MUST resolve it by',
    'EITHER:',
    '  1. If this PR changes the API contract (new/changed fields, enum members, request/response',
    '     shapes): update `packages/docs/openapi.yaml` to exactly match the change, and update the',
    '     frontend SDK. Prefer the repo\'s codegen script if one exists (check package.json scripts',
    '     for e.g. `generate:openapi`/`openapi`/`build:openapi` and run it); otherwise hand-edit the',
    '     spec. Do not leave it stale — the check re-runs on every push.',
    '  2. If this PR is a pure internal refactor with NO API contract change: do NOT edit the spec.',
    '     Instead, state clearly and prominently in your FINAL MESSAGE the exact line',
    '     `HERMES-APPLY-LABEL: skip-openapi-sync` (the harness applies it to bypass the check).',
    'Do not finish until you have done one of these two.',
  ].join('\n');
}

function buildFollowupPrompt(watch: PrWatch, _signals: PrSignal[], feedbackSummary: string, retry = ''): string {
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
    retry,
    openApiRemediation(feedbackSummary),
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

async function markFlowPausedIfPresent(issueKey: string, prUrl: string): Promise<void> {
  const flow = await getFlow(issueKey);
  if (!flow || flow.status === 'paused') return;
  await setFlow(issueKey, {
    ...flow,
    status: 'paused',
    prUrl,
    pauseReason: 'Ticket is not assigned to Hermes; automated PR fixes are paused.',
  });
}

async function markFlowRunningIfPresent(issueKey: string, prUrl: string, fixJobId?: string): Promise<void> {
  const flow = await getFlow(issueKey);
  if (!flow) return;
  await setFlow(issueKey, {
    ...flow,
    status: 'running',
    prUrl,
    ...(fixJobId ? { lastFixJobId: fixJobId } : {}),
    pauseReason: undefined,
  });
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

/**
 * True while the ticket is still Hermes's to work. Fail-open: if we can't determine assignment
 * (Jira unreachable, or the bot accountId is unknown) we keep working. Returns false only when we
 * positively determined the ticket is unassigned or reassigned to someone other than Hermes.
 */
async function isAssignedToHermes(issueKey: string): Promise<boolean> {
  const assignee = await getIssueAssigneeAccountId(issueKey);
  if (assignee === undefined) return true; // couldn't determine → keep working
  const hermes = await getBotAccountId();
  if (!hermes) return true; // no bot accountId to compare against → keep working
  return assignee === hermes; // assignee === null (unassigned) or a different person → stop
}

async function startFollowupJob(watch: PrWatch, signals: PrSignal[]): Promise<void> {
  // Do not make further commits once the ticket is no longer assigned to Hermes (someone took it
  // over / parked it). Post a one-time note and stop — reassigning to Hermes resumes it naturally.
  if (ASSIGNEE_GUARD_ENABLED && watch.issueKey && !(await isAssignedToHermes(watch.issueKey))) {
    console.warn(`[prmonitor] ${watch.repo}#${watch.prNumber}: ticket ${watch.issueKey} not assigned to Hermes — skipping follow-up commit`);
    const firstPause = await markWatchAssignmentPaused(watch);
    await markFlowPausedIfPresent(watch.issueKey, watch.prUrl).catch(() => {});
    if (firstPause) {
      await commentOnIssue(
        watch.issueKey,
        `⏸️ Hermes paused automated fixes for ${watch.prUrl} — this ticket is no longer assigned to Hermes. Reassign it to Hermes to resume.`
      ).catch(() => {});
    }
    return;
  }

  const wasAssignmentPaused = Boolean(
    watch.assignmentPausedAt || (watch.handledSignalIds ?? []).includes('unassigned-paused')
  );
  if (wasAssignmentPaused) {
    const firstResume = await clearWatchAssignmentPause(watch);
    if (watch.issueKey) {
      await markFlowRunningIfPresent(watch.issueKey, watch.prUrl).catch(() => {});
      if (firstResume) {
        await commentOnIssue(
          watch.issueKey,
          `▶️ Hermes resumed automated fixes for ${watch.prUrl} after the ticket was reassigned.`
        ).catch(() => {});
      }
    }
  }

  const nextAttempt = (watch.fixAttemptCount ?? 0) + 1;
  if (nextAttempt > MAX_FIX_ATTEMPTS) {
    await blockWatch(watch, `maximum automated fix attempts reached (${MAX_FIX_ATTEMPTS})`);
    return;
  }

  const signalIds = signals.map((s) => s.id);
  const { kind, jiraState } = followupKind(signals);
  const feedbackSummary = formatSignals(signals);
  const reviewReplyTargets = reviewReplyTargetsForSignals(signals);
  // Read the previous attempt's outcome before tryStartFix overwrites lastFixJobId with this one.
  const retry = isRetryOfHandledSignal(watch, signals) ? await retryContext(watch) : '';
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
      reviewReplyTargets: reviewReplyTargets.length ? reviewReplyTargets : undefined,
      source: `github:${watch.repo}#${watch.prNumber}`,
      prompt: buildFollowupPrompt(watch, signals, feedbackSummary, retry),
    });
    await appendHandledSignals(watch, signalIds);
    if (watch.issueKey) {
      await markFlowRunningIfPresent(watch.issueKey, watch.prUrl, job.jobId).catch(() => {});
    }
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
  // A `queued` job has not been picked up yet, so it has no heartbeat to go stale — its age is just
  // how long it has waited for a free worker. Reaping it on the heartbeat window killed real work
  // that was still going to run (and, before signals could re-fire, permanently froze the PR). Only
  // a job that actually STARTED is judged on its heartbeat; a queued one gets a long grace period so
  // a genuinely lost message is still eventually recovered.
  const staleWindow = job?.status === 'queued' ? QUEUED_FIX_GRACE_SECONDS : STALE_FIX_SECONDS;
  const stale = !job || terminal || jobAgeSeconds >= staleWindow;

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
      : job.status === 'queued'
        ? `active fix job was never picked up by a worker (${jobAgeSeconds}s queued)`
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

// --- WS5.1 --- Warn on cross-PR file overlap. Posts once per overlapping peer (deduped via a
// synthetic `overlap:<peer>` handled-signal id). Cheap and fully fail-open.
async function coordinateOverlaps(watch: PrWatch, changedFiles: string[], log: FastifyBaseLogger): Promise<void> {
  if (!OVERLAP_COORDINATION_ENABLED) return;
  try {
    const overlaps = await computeOverlaps(watch.repo, watch.prNumber, changedFiles);
    const handled = new Set(watch.handledSignalIds ?? []);
    const fresh = overlaps.filter((o) => !handled.has(`overlap:${o.prNumber}`));
    if (!fresh.length) return;
    const announced = await announceOverlaps(watch.repo, watch.prNumber, watch.prUrl, fresh);
    if (announced.length) await appendHandledSignals(watch, announced);
  } catch (err) {
    log.warn({ err, repo: watch.repo, prNumber: watch.prNumber }, 'WS5 overlap coordination failed');
  }
}

// --- WS5.3 --- Post the ticket checklist on the PR the first time its watch becomes active
// (deduped via `checklist-posted`). Fail-open.
async function postChecklistOnce(watch: PrWatch, log: FastifyBaseLogger): Promise<void> {
  if (!CHECKLIST_ENABLED || !watch.issueKey) return;
  if ((watch.handledSignalIds ?? []).includes('checklist-posted')) return;
  try {
    const flow = await getFlow(watch.issueKey);
    const items = flow?.checklist ?? [];
    if (!items.length) return;
    const body = renderChecklist(items);
    if (!body) return;
    await commentOnPullRequest(
      watch.repo,
      watch.prNumber,
      `${body}\n\nHermes will not move this PR to Ready for review until every item is checked \`- [x]\` or explicitly deferred to a follow-up ticket (DM-####).`
    );
    await appendHandledSignals(watch, ['checklist-posted']);
  } catch (err) {
    log.warn({ err, repo: watch.repo, prNumber: watch.prNumber }, 'WS5 checklist post failed');
  }
}

// --- WS5.3 + WS5.4 --- Additive readiness gate consulted only when CI already passes. Returns
// true (proceed to Ready) on satisfaction OR on any error (fail-open: never weaken CI behavior).
async function readinessGatesSatisfied(watch: PrWatch, log: FastifyBaseLogger): Promise<boolean> {
  if (!watch.issueKey || (!CHECKLIST_ENABLED && !EVIDENCE_CHECK_ENABLED)) return true;
  try {
    const [flow, issueContext, prText] = await Promise.all([
      getFlow(watch.issueKey),
      fetchIssueContext(watch.issueKey).catch(() => null),
      collectPrBodyAndComments(watch.repo, watch.prNumber),
    ]);

    const missing: string[] = [];
    if (CHECKLIST_ENABLED && flow?.checklist?.length) {
      const res = evaluateChecklist(flow.checklist, prText);
      if (!res.satisfied) missing.push(...res.missing.map((m) => `☐ ${m}`));
    }
    if (EVIDENCE_CHECK_ENABLED && issueContext) {
      const ids = extractEvidenceIds(issueContext);
      if (ids.length) {
        const res = evaluateEvidence(ids, prText);
        if (!res.satisfied) {
          missing.push(
            `Evidence/"Data repair" section referencing record ID(s) ${res.missing.join(', ')} with a before/after`
          );
        }
      }
    }

    if (!missing.length) return true;

    if (!(watch.handledSignalIds ?? []).includes('readiness-blocked')) {
      await commentOnIssue(
        watch.issueKey,
        [
          `🔒 Hermes is holding ${watch.prUrl} in code review: CI passes but the readiness checklist is not satisfied.`,
          '',
          'Outstanding:',
          ...missing.map((m) => `- ${m}`),
          '',
          'Check each item off in the PR (`- [x]`), defer it to a follow-up ticket (DM-####), or add the required evidence, then re-run.',
        ].join('\n')
      );
      await appendHandledSignals(watch, ['readiness-blocked']);
    }
    log.info({ repo: watch.repo, prNumber: watch.prNumber, missing }, 'WS5 readiness gate held PR in review');
    return false;
  } catch (err) {
    log.warn({ err, repo: watch.repo, prNumber: watch.prNumber }, 'WS5 readiness gate errored; failing open');
    return true;
  }
}

// --- WS5.2 --- After a Hermes PR merges, auto-rebase overlapping open Hermes PRs and re-validate.
async function rebaseOverlappingPrsAfterMerge(mergedWatch: PrWatch, log: FastifyBaseLogger): Promise<void> {
  if (!OVERLAP_COORDINATION_ENABLED) return;
  try {
    const mergedFiles = await listPullRequestChangedFiles(mergedWatch.repo, mergedWatch.prNumber).catch(() => [] as string[]);
    if (!mergedFiles.length) return;
    const mergedSet = new Set(mergedFiles);
    const peers = (await listActivePrWatches()).filter(
      (w) => w.repo === mergedWatch.repo && w.prNumber !== mergedWatch.prNumber
    );
    const dedupeId = `rebased-after:${mergedWatch.prNumber}`;

    for (const peer of peers) {
      try {
        if ((peer.handledSignalIds ?? []).includes(dedupeId)) continue;
        const peerFiles = await listPullRequestChangedFiles(peer.repo, peer.prNumber).catch(() => [] as string[]);
        const shared = peerFiles.filter((f) => mergedSet.has(f));
        if (!shared.length) continue;

        const rebase = await rebasePullRequestBranch(peer.repo, peer.headBranch, peer.baseBranch);
        const rebaseNote = rebase.ok
          ? `The branch was auto-rebased onto \`${peer.baseBranch}\` and re-validation was queued.`
          : rebase.conflict
            ? `Auto-rebase hit conflicts; a merge-conflict fix was queued to reconcile the branch.`
            : `Auto-rebase could not be applied automatically; a re-validation was queued.`;

        // Re-run the worker's gate/review on the (re)based branch via a synthetic merge-conflict
        // signal. Its id doubles as the dedupe marker (startFollowupJob persists handled ids).
        const signal: PrSignal = {
          id: dedupeId,
          kind: 'merge_conflict',
          headSha: peer.headSha,
          summary: `Overlapping Hermes PR #${mergedWatch.prNumber} merged; ${peer.baseBranch} advanced`,
          details: [
            `An overlapping Hermes PR (${mergedWatch.prUrl}) merged into ${peer.baseBranch} and changed files this PR also touches: ${shared.slice(0, 20).join(', ')}.`,
            `Reconcile ${peer.headBranch} with ${peer.baseBranch}, resolve any conflicts, and re-run validation.`,
          ].join(' '),
          createdAt: new Date().toISOString(),
        };
        await startFollowupJob(peer, [signal]);
        await commentOnPullRequest(
          peer.repo,
          peer.prNumber,
          `♻️ Overlapping Hermes PR ${mergedWatch.prUrl} merged and touched files this PR also changes. ${rebaseNote}`
        );
      } catch (err) {
        log.warn({ err, repo: peer.repo, prNumber: peer.prNumber, mergedPr: mergedWatch.prNumber }, 'WS5 per-peer rebase failed');
      }
    }
  } catch (err) {
    log.warn({ err, repo: mergedWatch.repo, prNumber: mergedWatch.prNumber }, 'WS5 post-merge overlap rebase failed');
  }
}

/**
 * Persist review memory after merge and leave a durable capture receipt on the watch.
 *
 * A durable capture request is created at merge before evaluating GitHub's snapshot. An immediate
 * snapshot with zero lessons gets one delayed refresh because GitHub can expose the merge before
 * its just-submitted approval appears in GraphQL. If it is still empty, leave the request pending;
 * a later backfill evaluates it once more. A backfill records zero as a valid terminal result so
 * clean/no-review PRs do not remain in the retry set forever.
 */
async function captureMergedReviewLearning(
  watch: PrWatch,
  initialSnapshot: Awaited<ReturnType<typeof collectPrSnapshot>>,
  log: FastifyBaseLogger,
  opts: { backfill?: boolean } = {}
): Promise<number> {
  const isBackfill = opts.backfill === true;
  if (hasCurrentReviewLearningCapture(watch)) {
    await markReviewLearningCaptureCompleted(
      watch,
      watch.reviewLearningLessonCount ?? 0,
      watch.reviewLearningMergeCommitSha ?? initialSnapshot.mergeCommitSha ?? initialSnapshot.headSha
    );
    return watch.reviewLearningLessonCount ?? 0;
  }

  let snapshot = initialSnapshot;
  let pendingRequestAvailable = isBackfill;
  if (!isBackfill) {
    try {
      await ensureReviewLearningCapturePending(
        watch,
        snapshot.mergeCommitSha || snapshot.headSha
      );
      pendingRequestAvailable = true;
    } catch (err) {
      log.warn(
        { err, repo: watch.repo, prNumber: watch.prNumber },
        'could not create durable PR-review capture request; continuing immediate capture'
      );
    }
  }

  if (!snapshot.reviewLessons.length && !isBackfill) {
    await new Promise((resolve) => setTimeout(resolve, REVIEW_LEARNING_MERGE_RETRY_MS));
    const refreshed = await collectPrSnapshot(watch);
    if (refreshed.state === 'MERGED') snapshot = refreshed;
  }

  const mergeCommitSha = snapshot.mergeCommitSha || snapshot.headSha;
  const recorded = await recordMergedReviewLessons({
    repo: watch.repo,
    type: watch.type,
    baseBranch: snapshot.baseBranch,
    prNumber: watch.prNumber,
    prUrl: snapshot.prUrl,
    mergeCommitSha,
    issueKey: watch.issueKey,
    labels: snapshot.labels,
    lessons: snapshot.reviewLessons,
  });

  if (shouldFinalizeReviewLearningCapture(recorded, isBackfill)) {
    const marked = await markReviewLearningCaptured(watch, recorded, mergeCommitSha);
    await markReviewLearningCaptureCompleted(watch, recorded, mergeCommitSha);
    if (marked) {
      log.info(
        { repo: watch.repo, prNumber: watch.prNumber, lessons: recorded, backfill: isBackfill },
        'completed accepted PR-review learning capture'
      );
    }
  } else {
    if (!pendingRequestAvailable) {
      try {
        await ensureReviewLearningCapturePending(watch, mergeCommitSha);
        pendingRequestAvailable = true;
      } catch (err) {
        log.error(
          { err, repo: watch.repo, prNumber: watch.prNumber },
          'empty PR-review capture has no durable retry request'
        );
      }
    }
    log.info(
      { repo: watch.repo, prNumber: watch.prNumber, durable: pendingRequestAvailable },
      'deferred empty PR-review learning capture to durable backfill'
    );
  }
  return recorded;
}

export function shouldFinalizeReviewLearningCapture(recorded: number, isBackfill = false): boolean {
  return recorded > 0 || isBackfill;
}

async function backfillPendingReviewLearning(
  watch: PrWatch,
  log: FastifyBaseLogger
): Promise<void> {
  const snapshot = await collectPrSnapshot(watch);
  if (snapshot.state !== 'MERGED') {
    throw new Error(
      `pending PR-review capture expected a merged PR but GitHub returned ${snapshot.state}`
    );
  }
  await captureMergedReviewLearning(watch, snapshot, log, { backfill: true });
}

export async function reconcilePrWatch(watch: PrWatch, log: FastifyBaseLogger, extraSignals: PrSignal[] = []): Promise<void> {
  let currentWatch = watch;
  const snapshot = await collectPrSnapshot(currentWatch, extraSignals);
  await updateWatchHead(currentWatch, snapshot.headSha, snapshot.headBranch, snapshot.prUrl);

  if (snapshot.state === 'MERGED') {
    const mergeCommitSha = snapshot.mergeCommitSha || snapshot.headSha;
    // Merge is the final acceptance gate for experiential review memory. Capture is idempotent and
    // fail-open: learning can never delay or block post-merge QA/deployment verification.
    try {
      await captureMergedReviewLearning(currentWatch, snapshot, log);
    } catch (err) {
      log.warn(
        { err, repo: currentWatch.repo, prNumber: currentWatch.prNumber },
        'failed to record PR-review lessons; continuing merge flow'
      );
    }
    // A terminal watch reached this branch only for bounded learning backfill. Do not repeat
    // overlap coordination or post-merge QA/deployment side effects.
    if (currentWatch.status === 'prwatch:done') return;
    let recoveryRun: WorkflowRunSummary | null = null;
    if (currentWatch.status === 'prwatch:blocked') {
      recoveryRun = await recoveryWorkflowSignal(currentWatch, mergeCommitSha, log);
      if (!recoveryRun) return;
    }
    // --- WS5.2 --- Rebase + re-validate overlapping open Hermes PRs before kicking off post-merge
    // QA/deploy verification (which return). Fail-open — never blocks the merge flow.
    await rebaseOverlappingPrsAfterMerge(currentWatch, log);
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

  // Auto-unblock: a watch that hit the fix cap (or was otherwise blocked) is normally never retried,
  // but if a HUMAN pushes a new commit to it the situation changed — give the fixer a fresh budget
  // and resume. Only triggers when the head advanced to a commit Hermes did not author.
  if (currentWatch.status === 'prwatch:blocked') {
    if (!AUTO_UNBLOCK_ON_HUMAN_COMMIT) return;
    const advanced = snapshot.headSha && snapshot.headSha !== currentWatch.headSha;
    if (!advanced || (await isHermesCommit(currentWatch.repo, snapshot.headSha))) return;
    const unblocked = await unblockWatch(currentWatch, snapshot.headSha);
    if (!unblocked) return;
    log.info(
      { repo: currentWatch.repo, prNumber: currentWatch.prNumber, headSha: snapshot.headSha.slice(0, 8) },
      'auto-unblocked PR watch after a human commit'
    );
    if (currentWatch.issueKey) {
      await commentOnIssue(
        currentWatch.issueKey,
        `▶️ A new commit was pushed to ${snapshot.prUrl}; Hermes resumed automated CI/review fixes.`
      ).catch(() => {});
    }
    currentWatch = unblocked;
  }

  await ensureFrontendDeployLabel(currentWatch, log);

  const recoveredWatch = await recoverStaleActiveFix(currentWatch, log);
  if (!recoveredWatch) {
    return;
  }
  currentWatch = recoveredWatch;

  // --- WS5.1 + WS5.3 --- Active-watch coordination: warn on cross-PR file overlap and post the
  // ticket checklist once. Both are best-effort and gated internally; they never short-circuit the
  // existing signal handling below.
  const activeWatch: PrWatch = { ...currentWatch, headSha: snapshot.headSha, headBranch: snapshot.headBranch, prUrl: snapshot.prUrl };
  await postChecklistOnce(activeWatch, log);
  if (OVERLAP_COORDINATION_ENABLED) {
    const changedFiles = await listPullRequestChangedFiles(currentWatch.repo, currentWatch.prNumber, snapshot.headSha).catch(
      () => [] as string[]
    );
    await coordinateOverlaps(activeWatch, changedFiles, log);
  }

  const actionable = dedupeNewSignals(currentWatch, snapshot.signals);
  if (actionable.length) {
    await startFollowupJob({ ...currentWatch, headSha: snapshot.headSha, headBranch: snapshot.headBranch, prUrl: snapshot.prUrl }, actionable);
    return;
  }

  // (An unresolved merge conflict used to be re-fired here, bypassing the handled-id dedupe. It is
  // now a self-clearing signal like any other, so dedupeNewSignals above re-fires it — under the
  // retry cooldown, which this bypassed.)

  if (snapshot.ciState === 'passing') {
    // CI is green and Hermes has addressed every review thread — but GitHub keeps the PR at
    // reviewDecision CHANGES_REQUESTED until that reviewer submits a NEW review, and a fixed PR does
    // not re-enter their queue by itself. Put it back there, once per head sha.
    //
    // This runs BEFORE the readiness gate on purpose. The gate governs whether Hermes advances the
    // *ticket* to Ready for review; it must not also withhold a re-review from a human who already
    // engaged with this PR and is now waiting on changes they asked for.
    if (REVIEW_REPING_ENABLED && (await markReviewPinged(currentWatch, snapshot.headSha))) {
      const pinged = await requestReReviewFromChangeRequesters(currentWatch.repo, currentWatch.prNumber);
      if (pinged.length) {
        log.info({ repo: currentWatch.repo, prNumber: currentWatch.prNumber, pinged }, 're-requested review on a green PR');
        await commentOnPullRequest(
          currentWatch.repo,
          currentWatch.prNumber,
          `♻️ CI is green and the requested changes have been addressed — re-requesting review from ${pinged.map((l) => `@${l}`).join(', ')}.`
        ).catch(() => {});
      }
    }

    // --- WS5.3 + WS5.4 --- Additive readiness gate: even with green CI, hold the PR in code review
    // until the ticket checklist is satisfied and any staging-record evidence is documented. Gate
    // fails open, so a gate error can never keep a green PR out of review.
    if (!(await readinessGatesSatisfied(currentWatch, log))) {
      return;
    }

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
  // GitHub's generated webhook schema has no resolution timestamp on the thread object. Capture
  // receipt at the handler boundary: this may conservatively reject a delayed pre-merge event, but
  // it can never make a post-merge resolution look as though the merge accepted it.
  const receivedAt = new Date().toISOString();
  if (!(await verifyGitHubSignature(rawBody, headers))) throw new Error('invalid GitHub signature');
  const deliveryId = String(headers['x-github-delivery'] ?? '');
  const eventName = String(headers['x-github-event'] ?? '');
  const { repo, prNumber, extraSignals } = payloadRepoAndPr(body);
  const resolutionEvidence = reviewThreadResolutionFromWebhook(body, eventName, receivedAt);

  // Record signed resolution-observation evidence before claiming the delivery. The evidence key
  // includes GitHub's delivery id, so a transient failure can safely let GitHub retry without
  // replacing the original receipt time.
  // This is the only conservative way to distinguish pre-merge from post-merge resolution:
  // GraphQL exposes current state but no resolution timestamp, and the webhook thread has none.
  if (repo && prNumber && resolutionEvidence) {
    await recordReviewThreadResolutionEvidence({
      repo,
      prNumber,
      deliveryId,
      ...resolutionEvidence,
    });
  }

  const firstDelivery = await rememberGitHubDelivery(deliveryId);
  if (!firstDelivery) return { ok: true, ignored: 'duplicate delivery' };

  if (!repo || !prNumber) return { ok: true, ignored: 'not a watched PR event' };

  // A CI run on a PR with ~27 checks emits ~54 check_run events, and each one used to drive a full
  // PR snapshot. Only a *completed* check can change our view of CI, and a burst of them says the
  // same thing repeatedly — so drop the rest. The 5-minute poll is the backstop for anything a
  // coalesced burst misses; the cost of not doing this is exhausting the hourly REST budget, which
  // stops the monitor completely.
  const isCheckEvent = Boolean(body.check_run || body.check_suite || body.workflow_run);
  if (isCheckEvent && !extraSignals.length) {
    const action = String(body.action ?? '');
    if (action && action !== 'completed') return { ok: true, ignored: `check event not completed (${action})` };
    const key = `${repo}#${prNumber}`;
    const last = recentWebhookReconciles.get(key) ?? 0;
    if (Date.now() - last < WEBHOOK_COALESCE_SECONDS * 1000) {
      return { ok: true, ignored: 'coalesced into a recent reconcile' };
    }
    recentWebhookReconciles.set(key, Date.now());
  }

  const watch = await getPrWatch(repo, prNumber);
  if (!watch) return { ok: true, ignored: 'PR is not watched by Hermes' };
  await reconcilePrWatch(watch, log, extraSignals);
  return { ok: true };
}

export async function reconcileOpenPrs(log: FastifyBaseLogger, opts: { periodic?: boolean } = {}): Promise<void> {
  // Only one replica sweeps per tick (an explicit POST /github/reconcile always runs).
  if (opts.periodic && !(await acquireReconcileLease(RECONCILE_LEASE_SECONDS))) {
    log.debug('another control-plane replica holds the reconcile lease this tick');
    return;
  }

  const [active, blocked, pendingLearningBackfill, migratedLearningBackfill] = await Promise.all([
    listActivePrWatches(),
    listBlockedPrWatches(),
    listReviewLearningBackfillWatches().catch((err) => {
      log.warn({ err }, 'failed to list pending PR-review captures; continuing normal reconcile');
      return [];
    }),
    seedLegacyReviewLearningCaptureRequests().catch((err) => {
      log.warn({ err }, 'failed to seed legacy PR-review captures; continuing normal reconcile');
      return [];
    }),
  ]);
  const learningBackfill = [
    ...new Map(
      [...pendingLearningBackfill, ...migratedLearningBackfill].map((watch) => [
        watch.jobId,
        watch,
      ])
    ).values(),
  ];
  const watches = [...active, ...blocked.filter(isRecoverableDeploymentBlock)];
  const budgetProbe = watches[0] ?? learningBackfill[0];
  if (!budgetProbe) return;

  // Leave headroom for webhook-driven reconciles and for the fix jobs themselves (which push, label
  // and comment). A sweep started on an empty budget just 403s its way through every watch.
  const remaining = await remainingRestBudget(budgetProbe.repo);
  if (remaining < RECONCILE_BUDGET_RESERVE) {
    log.warn(
      {
        remaining,
        reserve: RECONCILE_BUDGET_RESERVE,
        watches: watches.length,
        learningBackfill: learningBackfill.length,
      },
      'skipping PR reconcile sweep — GitHub REST budget too low'
    );
    return;
  }

  for (const watch of watches) {
    try {
      await reconcilePrWatch(watch, log);
    } catch (err) {
      if (isRateLimitError(err)) {
        // Every remaining watch would fail the same way; stop and let the next tick retry.
        log.error({ err, repo: watch.repo, prNumber: watch.prNumber }, 'GitHub rate limit hit — aborting reconcile sweep');
        return;
      }
      log.error({ err, repo: watch.repo, prNumber: watch.prNumber }, 'PR reconciliation failed');
    }
  }

  // Pending capture requests are learning-only: never send their watches back through coordination,
  // ticket transitions, or post-merge deployment orchestration.
  for (const watch of learningBackfill) {
    try {
      await backfillPendingReviewLearning(watch, log);
    } catch (err) {
      if (isRateLimitError(err)) {
        log.error(
          { err, repo: watch.repo, prNumber: watch.prNumber },
          'GitHub rate limit hit — aborting PR-review learning backfill'
        );
        return;
      }
      const failure = await recordReviewLearningCaptureFailure(watch, err).catch(
        (failureError) => {
          log.warn(
            { err: failureError, repo: watch.repo, prNumber: watch.prNumber },
            'failed to update PR-review capture retry state'
          );
          return { attempts: 0, terminal: false };
        }
      );
      log.error(
        {
          err,
          repo: watch.repo,
          prNumber: watch.prNumber,
          captureAttempts: failure.attempts,
          captureDeadLettered: failure.terminal,
        },
        'PR-review learning backfill failed'
      );
    }
  }
}
