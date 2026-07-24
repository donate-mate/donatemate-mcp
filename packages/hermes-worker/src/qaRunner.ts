import type { HermesJob } from './jobs.js';
import {
  markFlowDone,
  markFlowRunning,
  markPrWatchQaDone,
  markPrWatchQaFailed,
  markPrWatchQaRunning,
  markPrWatchReadyForQa,
  storeJsonArtifact,
  updateJob,
} from './jobs.js';
import {
  dispatchWorkflow,
  fetchWorkflowRunLogs,
  getInstallationAuth,
  listWorkflowArtifacts,
  assertWorkflowExists,
  waitForDispatchedWorkflowConclusion,
  waitForWorkflowRunConclusion,
} from './github.js';
import { assignIssue, commentOnIssue, transitionIssue, COLUMN } from './jiraBot.js';
import { createLinkedDefect, setFixVersion } from './jiraBot.js';
import { lookupSlackUserMentionByEmail, notify, postSlackChannelMessage } from './notify.js';
import { configuredSlackUserMention, jiraIssueSlackLink } from './slackFormat.js';

interface QaPlanScenario {
  id: string;
  title: string;
  priority: string;
  platforms: string[];
  selection: 'direct' | 'regression';
  reason: string;
  automationStatus: 'mapped' | 'missing';
  automationPath?: string;
  pageUrl: string;
}

interface QaProofPlan {
  version: 1;
  mode: 'full_catalog_post_merge';
  automationDisabled?: boolean;
  repo: string;
  prNumber: number;
  prUrl: string;
  mergeCommitSha: string;
  baseBranch: string;
  issueKey?: string;
  build: { workflowId: string; branch: string; headSha?: string; runUrl?: string; recoveredFromMergeCommitSha?: string };
  execution: { workflowId: string; requireAllExecutableScenarios: boolean; requireIosAndAndroid: boolean };
  scenarioStats: {
    selected: number;
    direct: number;
    regression: number;
    missingAutomation: number;
    defectHeld: number;
    staged: number;
  };
  coverageGaps?: Array<{ kind: 'missing_direct_scenario'; reason: string }>;
  scenarios: QaPlanScenario[];
}

const BUILD_WAIT_SECONDS = Number(process.env.QA_BUILD_WAIT_SECONDS ?? 7200);
const QA_WAIT_SECONDS = Number(process.env.QA_EXECUTION_WAIT_SECONDS ?? 7200);
const POLL_SECONDS = Number(process.env.QA_POLL_SECONDS ?? 60);
const FE_TESTFLIGHT_FIX_VERSION = (process.env.FE_TESTFLIGHT_FIX_VERSION || '').trim();
const FE_TESTFLIGHT_RELEASE_VERSION = (process.env.FE_TESTFLIGHT_RELEASE_VERSION || FE_TESTFLIGHT_FIX_VERSION).trim();
const ALLOW_CONFIGURED_FE_TESTFLIGHT_FALLBACK = /^(1|true|yes)$/i.test(process.env.FE_TESTFLIGHT_ALLOW_CONFIGURED_FALLBACK ?? 'false');
const QA_ASSIGNEE_ACCOUNT_ID = process.env.QA_ASSIGNEE_ACCOUNT_ID || '712020:1782f20d-c1fc-4831-ac3f-925cc0773332';
const QA_ASSIGNEE_NAME = process.env.QA_ASSIGNEE_NAME || 'Patrick Sheehy';
const QA_ASSIGNEE_EMAIL = process.env.QA_ASSIGNEE_EMAIL || 'patrick.sheehy@donate-mate.com';
const QA_SLACK_CHANNEL = process.env.QA_SLACK_CHANNEL || '#qa';
const QA_SLACK_MENTION = process.env.QA_SLACK_MENTION || '';
const QA_AUTOMATION_ENABLED = /^(1|true|yes)$/i.test(process.env.QA_AUTOMATION_ENABLED ?? 'false');

interface FeReleaseInfo {
  fixVersion: string;
  releaseVersion: string;
  source: 'workflow_logs' | 'configured' | 'unconfirmed';
}

function parsePlan(job: HermesJob): QaProofPlan {
  try {
    const parsed = JSON.parse(job.prompt) as QaProofPlan;
    if (parsed.version !== 1 || parsed.mode !== 'full_catalog_post_merge') {
      throw new Error('unsupported QA plan version/mode');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid QA proof plan in job prompt: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeFixVersion(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function configuredFeReleaseInfo(): FeReleaseInfo | null {
  if (!ALLOW_CONFIGURED_FE_TESTFLIGHT_FALLBACK) return null;
  const fixVersion = normalizeFixVersion(FE_TESTFLIGHT_FIX_VERSION);
  if (!fixVersion) return null;
  return {
    fixVersion,
    releaseVersion: FE_TESTFLIGHT_RELEASE_VERSION || fixVersion,
    source: 'configured',
  };
}

function unconfirmedFeReleaseInfo(): FeReleaseInfo {
  return {
    fixVersion: 'unconfirmed',
    releaseVersion: 'unconfirmed',
    source: 'unconfirmed',
  };
}

function fallbackFeReleaseInfo(): FeReleaseInfo {
  return configuredFeReleaseInfo() ?? unconfirmedFeReleaseInfo();
}

function latestMatch(text: string, pattern: RegExp): string | undefined {
  let value: string | undefined;
  for (const match of text.matchAll(pattern)) {
    value = match[1]?.trim();
  }
  return value;
}

export function parseFeReleaseInfoFromLogs(logs: string): FeReleaseInfo | null {
  const appVersion = latestMatch(logs, /App Version\s*:\s*([^\n\r]+)/gi);
  if (!appVersion) return null;

  const iosBuildNumber = latestMatch(logs, /Build number\s*:\s*([^\n\r]+)/gi);
  const androidVersionCode = latestMatch(logs, /Version code\s*:\s*([^\n\r]+)/gi);
  const buildLabel =
    iosBuildNumber && androidVersionCode && iosBuildNumber !== androidVersionCode
      ? `iOS ${iosBuildNumber} / Android ${androidVersionCode}`
      : iosBuildNumber || androidVersionCode;
  const fixVersion = normalizeFixVersion(appVersion);

  return {
    fixVersion,
    releaseVersion: buildLabel ? `${fixVersion} (${buildLabel})` : fixVersion,
    source: 'workflow_logs',
  };
}

async function deriveFeReleaseInfo(token: string, job: HermesJob, buildRun: Awaited<ReturnType<typeof waitForWorkflowRunConclusion>>): Promise<FeReleaseInfo> {
  try {
    const logs = await fetchWorkflowRunLogs(token, job.repo, buildRun.id);
    return parseFeReleaseInfoFromLogs(logs) ?? fallbackFeReleaseInfo();
  } catch (err) {
    console.warn(`[${job.jobId}] failed to derive TestFlight release from workflow logs: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackFeReleaseInfo();
  }
}

function canApplyFixVersion(releaseInfo: FeReleaseInfo): boolean {
  return releaseInfo.source !== 'unconfirmed' && releaseInfo.fixVersion !== 'unconfirmed';
}

function fixVersionStatusSuffix(releaseInfo: FeReleaseInfo, fixVersionApplied: boolean): string {
  if (!canApplyFixVersion(releaseInfo)) return ' (not updated; Hermes could not derive this from deployment logs)';
  return fixVersionApplied ? '' : ' (update failed; verify in Jira)';
}

function releaseSourceText(releaseInfo: FeReleaseInfo): string {
  if (releaseInfo.source === 'workflow_logs') return 'Release source: deployment workflow logs.';
  if (releaseInfo.source === 'configured') return 'Release source: configured fallback.';
  return 'Release source: unconfirmed; deployment logs did not expose an app version/build number.';
}

function compactMissing(plan: QaProofPlan, max = 20): string {
  const missing = plan.scenarios.filter((scenario) => scenario.automationStatus === 'missing');
  const rows = missing.slice(0, max).map((scenario) => `- ${scenario.id}: ${scenario.title} (${scenario.pageUrl})`);
  if (missing.length > max) rows.push(`- ...and ${missing.length - max} more`);
  return rows.join('\n');
}

function compactSelected(plan: QaProofPlan, kind: 'direct' | 'regression', max = 12): string {
  const selected = plan.scenarios.filter((scenario) => scenario.selection === kind);
  const rows = selected.slice(0, max).map((scenario) => `- ${scenario.id}: ${scenario.reason}`);
  if (selected.length > max) rows.push(`- ...and ${selected.length - max} more`);
  return rows.join('\n') || '- none';
}

function isQaAutomationDisabled(plan: QaProofPlan): boolean {
  return plan.automationDisabled === true || !QA_AUTOMATION_ENABLED;
}

async function postQaFailure(job: HermesJob, plan: QaProofPlan, reason: string, planUri: string): Promise<void> {
  await updateJob(job.jobId, 'failed', { error: reason.slice(0, 1000), qaPlanUri: planUri });
  if (job.prNumber) await markPrWatchQaFailed(job.repo, job.prNumber, reason);
  await notify(job, `:x: Hermes QA proof failed for ${plan.prUrl}: ${reason}`);
  if (job.issueKey) {
    await commentOnIssue(
      job.issueKey,
      [
        `❌ Post-merge QA proof could not complete for ${plan.prUrl}.`,
        '',
        `Reason: ${reason}`,
        '',
        `QA plan: \`${planUri}\``,
      ].join('\n')
    );
    await transitionIssue(job.issueKey, COLUMN.blocked);
    await markFlowDone(job.issueKey, { flowError: reason.slice(0, 200), prUrl: plan.prUrl });
  }
}

async function postQaCoverageGap(job: HermesJob, plan: QaProofPlan, reason: string, planUri: string, details: string): Promise<void> {
  await updateJob(job.jobId, 'failed', { error: reason.slice(0, 1000), qaPlanUri: planUri });
  await notify(job, `:warning: Hermes QA proof is incomplete for ${plan.prUrl}: ${reason}`);
  if (job.issueKey) {
    await commentOnIssue(
      job.issueKey,
      [
        `⚠️ Automated QA proof is incomplete for ${plan.prUrl}.`,
        '',
        `Reason: ${reason}`,
        '',
        details,
        '',
        'The deployment is still available for QA. A developer should add or approve the missing QA coverage before Hermes can claim automated mitigation proof.',
        '',
        `QA plan: \`${planUri}\``,
      ].join('\n')
    );
    await markFlowDone(job.issueKey, { flowError: reason.slice(0, 200), prUrl: plan.prUrl, qaJobId: job.jobId });
  }
}

async function postDeploymentFailure(
  job: HermesJob,
  plan: QaProofPlan,
  reason: string,
  planUri: string,
  buildRunUrl?: string | null,
  releaseInfo: FeReleaseInfo = {
    fixVersion: 'unconfirmed',
    releaseVersion: 'unconfirmed',
    source: 'unconfirmed',
  }
): Promise<void> {
  const buildHeadSha = plan.build.headSha || plan.mergeCommitSha;
  await updateJob(job.jobId, 'failed', {
    error: reason.slice(0, 1000),
    qaPlanUri: planUri,
    buildRunUrl: buildRunUrl ?? '',
  });
  if (job.prNumber) await markPrWatchQaFailed(job.repo, job.prNumber, reason);
  await notify(job, `:x: Deployment failed after merge for ${plan.prUrl}: ${reason}`);

  if (!job.issueKey) return;

  const defectKey = await createLinkedDefect({
    sourceIssueKey: job.issueKey,
    summary: `[Deployment Defect] TestFlight deployment failed: ${reason}`,
    description: [
      `Frontend post-merge deployment failed before Ready for QA.`,
      '',
      `Source ticket: ${job.issueKey}`,
      `PR: ${plan.prUrl}`,
      `Merge commit: ${plan.mergeCommitSha}`,
      buildHeadSha !== plan.mergeCommitSha ? `Successful branch build commit: ${buildHeadSha}` : undefined,
      `Deployment workflow: ${buildRunUrl ?? plan.build.workflowId}`,
      `Reason: ${reason}`,
      `Target Jira Fix Version: ${releaseInfo.fixVersion}`,
      `Target TestFlight Release: ${releaseInfo.releaseVersion}`,
    ].filter(Boolean).join('\n'),
    labels: ['post-merge-deploy', 'testflight'],
    dedupeKey: reason,
  });

  await commentOnIssue(
    job.issueKey,
    [
      `❌ PR merged, but the TestFlight deployment failed for ${plan.prUrl}.`,
      '',
      `Deployment workflow: ${buildRunUrl ?? plan.build.workflowId}`,
      `Merge commit: \`${plan.mergeCommitSha}\``,
      buildHeadSha !== plan.mergeCommitSha ? `Successful branch build commit: \`${buildHeadSha}\`` : undefined,
      `Reason: ${reason}`,
      '',
      defectKey ? `Linked defect: ${defectKey}` : 'Hermes attempted to create a linked deployment defect, but Jira did not return one.',
      '',
      `QA plan: \`${planUri}\``,
    ].filter(Boolean).join('\n')
  );
  await transitionIssue(job.issueKey, COLUMN.blocked);
  await markFlowDone(job.issueKey, { flowError: reason.slice(0, 200), prUrl: plan.prUrl });
}

async function notifyReadyForQa(input: {
  job: HermesJob;
  plan: QaProofPlan;
  buildRunUrl: string;
  releaseInfo: FeReleaseInfo;
  fixVersionApplied: boolean;
  assigned: boolean;
}): Promise<void> {
  if (!input.job.issueKey) return;
  const issueLink = jiraIssueSlackLink(input.job.issueKey);
  const assigneeMention =
    configuredSlackUserMention(QA_SLACK_MENTION) || (await lookupSlackUserMentionByEmail(QA_ASSIGNEE_EMAIL)) || QA_ASSIGNEE_NAME;
  await postSlackChannelMessage(
    QA_SLACK_CHANNEL,
    [
      `${assigneeMention} ${issueLink} is ready for QA.`,
      `Jira Fix Version: ${input.releaseInfo.fixVersion}${fixVersionStatusSuffix(input.releaseInfo, input.fixVersionApplied)}`,
      `TestFlight Release: ${input.releaseInfo.releaseVersion}`,
      `Jira Assignee: ${input.assigned ? QA_ASSIGNEE_NAME : `assignment failed; assign to ${QA_ASSIGNEE_NAME}`}`,
      `PR: ${input.plan.prUrl}`,
      `Deployment Workflow: ${input.buildRunUrl}`,
    ].join('\n')
  );
}

export async function processQaProofJob(job: HermesJob): Promise<void> {
  const plan = parsePlan(job);
  const automationDisabled = isQaAutomationDisabled(plan);
  const planUri = await storeJsonArtifact(job.jobId, 'qa-proof-plan', plan);
  const buildHeadSha = plan.build.headSha || plan.mergeCommitSha;

  await updateJob(job.jobId, 'running', { qaPlanUri: planUri });
  if (job.prNumber) await markPrWatchQaRunning(job.repo, job.prNumber);
  if (job.issueKey) {
    await markFlowRunning(job.issueKey, { prUrl: plan.prUrl, qaJobId: job.jobId });
    await commentOnIssue(
      job.issueKey,
      [
        automationDisabled ? `Post-merge readiness tracking started for ${plan.prUrl}.` : `🧪 Post-merge QA proof started for ${plan.prUrl}.`,
        '',
        `Merge commit: \`${plan.mergeCommitSha}\``,
        buildHeadSha !== plan.mergeCommitSha ? `Using successful branch build commit: \`${buildHeadSha}\`` : undefined,
        plan.build.runUrl ? `Recovered build workflow: ${plan.build.runUrl}` : undefined,
        `Waiting for deployment workflow: ${plan.build.workflowId}`,
        automationDisabled ? 'Automated QA execution is disabled; Hermes will move this ticket to Ready for QA after the deployment succeeds.' : undefined,
        !automationDisabled ? `Executable scenarios selected: ${plan.scenarioStats.selected}` : undefined,
        !automationDisabled ? `Direct: ${plan.scenarioStats.direct} | Regression: ${plan.scenarioStats.regression}` : undefined,
        !automationDisabled ? `Skipped defect-held: ${plan.scenarioStats.defectHeld} | skipped staged: ${plan.scenarioStats.staged}` : undefined,
        `QA plan: \`${planUri}\``,
        !automationDisabled ? '' : undefined,
        !automationDisabled ? `Direct scenarios:\n${compactSelected(plan, 'direct')}` : undefined,
      ].filter(Boolean).join('\n')
    );
  }

  const { token, octokit } = await getInstallationAuth(job.repo);

  let buildRun: Awaited<ReturnType<typeof waitForWorkflowRunConclusion>>;
  try {
    buildRun = await waitForWorkflowRunConclusion({
      octokit,
      repo: job.repo,
      workflowId: plan.build.workflowId,
      headSha: buildHeadSha,
      branch: plan.build.branch,
      timeoutSeconds: BUILD_WAIT_SECONDS,
      pollSeconds: POLL_SECONDS,
    });
  } catch (err) {
    await postDeploymentFailure(
      job,
      plan,
      `deployment workflow did not complete: ${err instanceof Error ? err.message : String(err)}`,
      planUri
    );
    return;
  }

  const releaseInfo = buildRun.conclusion === 'success' ? await deriveFeReleaseInfo(token, job, buildRun) : undefined;

  if (buildRun.conclusion !== 'success') {
    await postDeploymentFailure(
      job,
      plan,
      `test build workflow ${plan.build.workflowId} concluded ${buildRun.conclusion ?? 'without success'}`,
      planUri,
      buildRun.htmlUrl
    );
    return;
  }

  if (job.issueKey) {
    const resolvedReleaseInfo = releaseInfo ?? {
      fixVersion: 'unconfirmed',
      releaseVersion: 'unconfirmed',
      source: 'unconfirmed' as const,
    };
    const fixVersionApplied = canApplyFixVersion(resolvedReleaseInfo) ? await setFixVersion(job.issueKey, resolvedReleaseInfo.fixVersion) : false;
    const assigned = await assignIssue(job.issueKey, QA_ASSIGNEE_ACCOUNT_ID);
    await commentOnIssue(
      job.issueKey,
      [
        `✅ PR merged and TestFlight deployment succeeded for ${plan.prUrl}.`,
        '',
        `Deployment workflow: ${buildRun.htmlUrl ?? plan.build.workflowId}`,
        `Merge commit: \`${plan.mergeCommitSha}\``,
        buildHeadSha !== plan.mergeCommitSha ? `Successful branch build commit: \`${buildHeadSha}\`` : undefined,
        `Jira Fix Version: ${resolvedReleaseInfo.fixVersion}${fixVersionStatusSuffix(resolvedReleaseInfo, fixVersionApplied)}`,
        `TestFlight Release: ${resolvedReleaseInfo.releaseVersion}`,
        releaseSourceText(resolvedReleaseInfo),
        `Jira Assignee: ${assigned ? QA_ASSIGNEE_NAME : `assignment failed; assign to ${QA_ASSIGNEE_NAME}`}`,
        '',
        'Moving this ticket to Ready for QA.',
      ].filter(Boolean).join('\n')
    );
    await transitionIssue(job.issueKey, COLUMN.qa);
    await markFlowRunning(job.issueKey, { prUrl: plan.prUrl, qaJobId: job.jobId, buildRunUrl: buildRun.htmlUrl ?? '' });
    await notifyReadyForQa({
      job,
      plan,
      buildRunUrl: buildRun.htmlUrl ?? plan.build.workflowId,
      releaseInfo: resolvedReleaseInfo,
      fixVersionApplied,
      assigned,
    });
  }
  if (job.prNumber) await markPrWatchReadyForQa(job.repo, job.prNumber, buildRun.htmlUrl ?? undefined);

  if (automationDisabled) {
    await updateJob(job.jobId, 'done', {
      qaPlanUri: planUri,
      buildRunUrl: buildRun.htmlUrl ?? '',
    });
    await notify(job, `:white_check_mark: Hermes marked ${plan.prUrl} ready for QA after deployment succeeded. Automated QA execution is disabled.`);
    if (job.issueKey) {
      await markFlowDone(job.issueKey, { prUrl: plan.prUrl, qaJobId: job.jobId, buildRunUrl: buildRun.htmlUrl ?? '' });
    }
    return;
  }

  const missingAutomation = plan.scenarios.filter((scenario) => scenario.automationStatus === 'missing');
  if (plan.coverageGaps?.length) {
    await postQaCoverageGap(
      job,
      plan,
      `Confluence QA coverage gap: ${plan.coverageGaps.map((gap) => gap.reason).join(' ')}`,
      planUri,
      plan.coverageGaps.map((gap) => `- ${gap.reason}`).join('\n')
    );
    return;
  }

  if (missingAutomation.length) {
    await postQaCoverageGap(
      job,
      plan,
      `${missingAutomation.length} executable Confluence QA scenario(s) do not have Maestro automation mappings`,
      planUri,
      compactMissing(plan)
    );
    return;
  }

  const scenarioIds = plan.scenarios.map((scenario) => scenario.id);
  try {
    await assertWorkflowExists(octokit, job.repo, plan.execution.workflowId);
  } catch (err) {
    await postQaCoverageGap(
      job,
      plan,
      `QA execution workflow ${plan.execution.workflowId} is not available to Hermes: ${err instanceof Error ? err.message : String(err)}`,
      planUri,
      'The TestFlight deployment succeeded, but Hermes could not dispatch the automated QA workflow.'
    );
    return;
  }

  const dispatchedAt = new Date().toISOString();
  await dispatchWorkflow({
    octokit,
    repo: job.repo,
    workflowId: plan.execution.workflowId,
    ref: plan.baseBranch,
    inputs: {
      qa_plan_s3_uri: planUri,
      qa_plan_json: JSON.stringify({
        jobId: job.jobId,
        issueKey: job.issueKey ?? '',
        prNumber: String(plan.prNumber),
        prUrl: plan.prUrl,
        mergeCommitSha: plan.mergeCommitSha,
        buildHeadSha,
        scenarioIds,
      }),
      scenario_ids: scenarioIds.join(','),
      merge_commit_sha: plan.mergeCommitSha,
      jira_issue: job.issueKey ?? '',
    },
  });

  const qaRun = await waitForDispatchedWorkflowConclusion({
    octokit,
    repo: job.repo,
    workflowId: plan.execution.workflowId,
    branch: plan.baseBranch,
    createdAfterIso: dispatchedAt,
    timeoutSeconds: QA_WAIT_SECONDS,
    pollSeconds: POLL_SECONDS,
  });

  if (qaRun.conclusion !== 'success') {
    await postQaFailure(
      job,
      plan,
      `QA execution workflow ${plan.execution.workflowId} concluded ${qaRun.conclusion ?? 'without success'}`,
      planUri
    );
    return;
  }

  const artifacts = await listWorkflowArtifacts(octokit, job.repo, qaRun.id).catch(() => []);
  const artifactSummary = artifacts.length
    ? artifacts
        .slice(0, 12)
        .map((artifact) => `- ${artifact.name}${artifact.archiveDownloadUrl ? `: ${artifact.archiveDownloadUrl}` : ''}`)
        .join('\n')
    : '- no workflow artifacts were reported';

  await updateJob(job.jobId, 'done', {
    qaPlanUri: planUri,
    qaRunUrl: qaRun.htmlUrl ?? '',
    buildRunUrl: buildRun.htmlUrl ?? '',
  });
  if (job.prNumber) await markPrWatchQaDone(job.repo, job.prNumber);
  await notify(job, `:white_check_mark: Hermes QA proof passed for ${plan.prUrl}: ${qaRun.htmlUrl ?? 'workflow completed'}`);
  if (job.issueKey) {
    await commentOnIssue(
      job.issueKey,
      [
        `✅ Post-merge QA proof passed for ${plan.prUrl}.`,
        '',
        `Merge commit: \`${plan.mergeCommitSha}\``,
        `Build workflow: ${buildRun.htmlUrl ?? plan.build.workflowId}`,
        `QA workflow / videos: ${qaRun.htmlUrl ?? plan.execution.workflowId}`,
        '',
        `Artifacts:\n${artifactSummary}`,
        '',
        `Scenarios executed: ${plan.scenarioStats.selected} (${plan.scenarioStats.direct} direct, ${plan.scenarioStats.regression} regression)`,
        `QA plan: \`${planUri}\``,
      ].join('\n')
    );
    await transitionIssue(job.issueKey, COLUMN.done);
    await markFlowDone(job.issueKey, { prUrl: plan.prUrl, qaJobId: job.jobId });
  }
}
