/**
 * Jira-ticket coding flow state. When a ticket is assigned to Hermes we derive a plan and wait
 * for a `/go` confirmation before queuing the job (two-step plan→confirm handshake). The state
 * lives in the jobs table under a synthetic key so a re-fired webhook (Jira retries) is a no-op
 * rather than a double-queue.
 *   jiraflow:<ISSUE-KEY> → { status, taskPrompt, repo, type, plan, jobId? }
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkerType } from './jobs.js';

// --- WS5 --- drop undefined attributes (e.g. absent jobId/checklist) so PutCommand won't throw.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.JOBS_TABLE!;

export type FlowStatus = 'awaiting_confirm' | 'running' | 'done';

export interface JiraFlow {
  status: FlowStatus;
  taskPrompt: string;
  repo: string;
  type: WorkerType;
  plan: string;
  jobId?: string;
  // --- WS5 --- Acceptance/defect checklist derived from the ticket, used for readiness gating.
  checklist?: string[];
}

const flowKey = (issueKey: string) => `jiraflow:${issueKey.toUpperCase()}`;

export async function getFlow(issueKey: string): Promise<JiraFlow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId: flowKey(issueKey) } }));
  if (!r.Item) return undefined;
  const { status, taskPrompt, repo, type, plan, flowJobId, checklist } = r.Item as Record<string, unknown>;
  // --- WS5 --- surface the persisted checklist (may be absent on older flow rows).
  return { status, taskPrompt, repo, type, plan, jobId: flowJobId, checklist } as JiraFlow;
}

export async function setFlow(issueKey: string, flow: JiraFlow): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        jobId: flowKey(issueKey),
        status: flow.status,
        taskPrompt: flow.taskPrompt,
        repo: flow.repo,
        type: flow.type,
        plan: flow.plan,
        flowJobId: flow.jobId,
        checklist: flow.checklist, // --- WS5 ---
        updatedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      },
    })
  );
}
