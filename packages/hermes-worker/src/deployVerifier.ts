import type { HermesJob } from './jobs.js';
import { markFlowDone, markFlowRunning, markPrWatchQaFailed, markPrWatchReadyForQa, storeJsonArtifact, updateJob } from './jobs.js';
import { assertWorkflowExists, getInstallationAuth, waitForWorkflowRunConclusion, type WorkflowRunSummary } from './github.js';
import { assignIssue, commentOnIssue, createLinkedDefect, transitionIssue, COLUMN } from './jiraBot.js';
import { lookupSlackUserMentionByEmail, notify, postSlackChannelMessage } from './notify.js';
import { configuredSlackUserMention, jiraIssueSlackLink } from './slackFormat.js';

interface DeploymentVerificationPlan {
  version: 1;
  mode: 'post_merge_deployment';
  createdAt: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  mergeCommitSha: string;
  baseBranch: string;
  issueKey?: string;
  deployment: {
    workflowId: string;
    branch: string;
    headSha?: string;
    runUrl?: string;
    recoveredFromMergeCommitSha?: string;
  };
}

const DEPLOY_WAIT_SECONDS = Number(process.env.DEPLOY_WAIT_SECONDS ?? 7200);
const POLL_SECONDS = Number(process.env.DEPLOY_POLL_SECONDS ?? process.env.QA_POLL_SECONDS ?? 60);
const SUPERSEDING_RUN_GRACE_SECONDS = Number(process.env.DEPLOY_SUPERSEDING_RUN_GRACE_SECONDS ?? 300);
const QA_ASSIGNEE_ACCOUNT_ID =
  process.env.BE_QA_ASSIGNEE_ACCOUNT_ID || process.env.QA_ASSIGNEE_ACCOUNT_ID || '712020:5168d41e-0688-4f0d-8e00-a3e2048c556e';
const QA_ASSIGNEE_NAME = process.env.BE_QA_ASSIGNEE_NAME || process.env.QA_ASSIGNEE_NAME || 'Andrew Sheehy';
const QA_ASSIGNEE_EMAIL = process.env.BE_QA_ASSIGNEE_EMAIL || process.env.QA_ASSIGNEE_EMAIL || 'andrew.sheehy@donate-mate.com';
const QA_SLACK_CHANNEL = process.env.QA_SLACK_CHANNEL || '#qa';
const QA_SLACK_MENTION = process.env.BE_QA_SLACK_MENTION || process.env.QA_SLACK_MENTION || '';

function parsePlan(job: HermesJob): DeploymentVerificationPlan {
  try {
    const parsed = JSON.parse(job.prompt) as DeploymentVerificationPlan;
    if (parsed.version !== 1 || parsed.mode !== 'post_merge_deployment') {
      throw new Error('unsupported deployment verification plan');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid deployment verification plan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function blockForDeploymentFailure(
  job: HermesJob,
  plan: DeploymentVerificationPlan,
  reason: string,
  planUri: string,
  deployRun?: WorkflowRunSummary
): Promise<void> {
  const runText = deployRun?.htmlUrl ?? plan.deployment.workflowId;
  const deployHeadSha = plan.deployment.headSha || plan.mergeCommitSha;
  await updateJob(job.jobId, 'failed', {
    error: reason.slice(0, 1000),
    qaPlanUri: planUri,
    deployRunUrl: deployRun?.htmlUrl ?? '',
  });
  await markPrWatchQaFailed(job.repo, plan.prNumber, reason);
  await notify(job, `:x: Deployment failed after merge for ${plan.prUrl}: ${reason}`);

  if (!job.issueKey) return;

  const defectKey = await createLinkedDefect({
    sourceIssueKey: job.issueKey,
    summary: `[Deployment Defect] Post-merge deployment failed: ${reason}`,
    description: [
      `Deployment failed after Hermes PR merge.`,
      '',
      `Source ticket: ${job.issueKey}`,
      `PR: ${plan.prUrl}`,
      `Merge commit: ${plan.mergeCommitSha}`,
      deployHeadSha !== plan.mergeCommitSha ? `Successful branch deployment commit: ${deployHeadSha}` : undefined,
      `Deployment workflow: ${runText}`,
      `Reason: ${reason}`,
    ].filter(Boolean).join('\n'),
    labels: ['post-merge-deploy'],
    dedupeKey: reason,
  });

  await commentOnIssue(
    job.issueKey,
    [
      `❌ PR merged, but deployment failed for ${plan.prUrl}.`,
      '',
      `Deployment workflow: ${runText}`,
      `Merge commit: \`${plan.mergeCommitSha}\``,
      deployHeadSha !== plan.mergeCommitSha ? `Successful branch deployment commit: \`${deployHeadSha}\`` : undefined,
      `Reason: ${reason}`,
      '',
      defectKey ? `Linked defect: ${defectKey}` : 'Hermes attempted to create a linked deployment defect, but Jira did not return one.',
      '',
      `Deployment plan: \`${planUri}\``,
    ].filter(Boolean).join('\n')
  );
  await transitionIssue(job.issueKey, COLUMN.blocked);
  await markFlowDone(job.issueKey, { flowError: reason.slice(0, 200), prUrl: plan.prUrl });
}

export async function processDeploymentVerificationJob(job: HermesJob): Promise<void> {
  const plan = parsePlan(job);
  const planUri = await storeJsonArtifact(job.jobId, 'deployment-verification-plan', plan);
  const deployHeadSha = plan.deployment.headSha || plan.mergeCommitSha;

  await updateJob(job.jobId, 'running', { qaPlanUri: planUri });
  if (job.issueKey) {
    await markFlowRunning(job.issueKey, { prUrl: plan.prUrl, deployJobId: job.jobId });
  }

  const { octokit } = await getInstallationAuth(job.repo);
  await assertWorkflowExists(octokit, job.repo, plan.deployment.workflowId).catch((err) => {
    console.warn(
      `[${job.jobId}] deployment workflow lookup failed; falling back to commit check-runs: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  let deployRun: WorkflowRunSummary;
  try {
    deployRun = await waitForWorkflowRunConclusion({
      octokit,
      repo: job.repo,
      workflowId: plan.deployment.workflowId,
      headSha: deployHeadSha,
      branch: plan.deployment.branch,
      timeoutSeconds: DEPLOY_WAIT_SECONDS,
      pollSeconds: POLL_SECONDS,
      followSupersedingRuns: true,
      supersedingRunGraceSeconds: SUPERSEDING_RUN_GRACE_SECONDS,
    });
  } catch (err) {
    await blockForDeploymentFailure(
      job,
      plan,
      `deployment workflow did not complete: ${err instanceof Error ? err.message : String(err)}`,
      planUri
    );
    return;
  }

  if (deployRun.conclusion !== 'success') {
    await blockForDeploymentFailure(
      job,
      plan,
      `deployment workflow ${plan.deployment.workflowId} concluded ${deployRun.conclusion ?? 'without success'}`,
      planUri,
      deployRun
    );
    return;
  }

  await updateJob(job.jobId, 'done', {
    qaPlanUri: planUri,
    deployRunUrl: deployRun.htmlUrl ?? '',
  });
  await markPrWatchReadyForQa(job.repo, plan.prNumber, deployRun.htmlUrl ?? undefined);
  await notify(job, `:white_check_mark: Deployment passed for ${plan.prUrl}: ${deployRun.htmlUrl ?? 'workflow completed'}`);

  if (job.issueKey) {
    const assigned = await assignIssue(job.issueKey, QA_ASSIGNEE_ACCOUNT_ID);
    await commentOnIssue(
      job.issueKey,
      [
        `✅ PR merged and deployment succeeded for ${plan.prUrl}.`,
        '',
        `Deployment workflow: ${deployRun.htmlUrl ?? plan.deployment.workflowId}`,
        `Merge commit: \`${plan.mergeCommitSha}\``,
        deployHeadSha !== plan.mergeCommitSha ? `Successful branch deployment commit: \`${deployHeadSha}\`` : undefined,
        `Jira Assignee: ${assigned ? QA_ASSIGNEE_NAME : `assignment failed; assign to ${QA_ASSIGNEE_NAME}`}`,
        '',
        'Moving this ticket to Ready for QA.',
      ].filter(Boolean).join('\n')
    );
    await transitionIssue(job.issueKey, COLUMN.qa);
    const issueLink = jiraIssueSlackLink(job.issueKey);
    const assigneeMention =
      configuredSlackUserMention(QA_SLACK_MENTION) || (await lookupSlackUserMentionByEmail(QA_ASSIGNEE_EMAIL)) || QA_ASSIGNEE_NAME;
    await postSlackChannelMessage(
      QA_SLACK_CHANNEL,
      [
        `${assigneeMention} ${issueLink} is ready for QA.`,
        `Jira Assignee: ${assigned ? QA_ASSIGNEE_NAME : `assignment failed; assign to ${QA_ASSIGNEE_NAME}`}`,
        `PR: ${plan.prUrl}`,
        `Deployment Workflow: ${deployRun.htmlUrl ?? plan.deployment.workflowId}`,
      ].join('\n')
    );
    await markFlowDone(job.issueKey, { prUrl: plan.prUrl, deployRunUrl: deployRun.htmlUrl ?? '' });
  }
}
