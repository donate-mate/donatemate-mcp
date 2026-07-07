/**
 * Job intake: write a row to the Hermes jobs table and enqueue it on SQS.
 * The worker pool consumes from the queue and processes each job.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});

const TABLE = process.env.JOBS_TABLE!;
const QUEUE = process.env.JOBS_QUEUE_URL!;

export type WorkerType = 'fe' | 'be' | 'qa';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobKind =
  | 'implementation'
  | 'ci_fix'
  | 'review_fix'
  | 'merge_conflict_fix'
  | 'combined_followup'
  | 'deploy_verification'
  | 'qa_proof';

// Default branch each worker type targets when a job doesn't specify one. The FE app's `main`
// is a deploy-test skeleton — real code lives on `staging` — so FE/QA default there.
const DEFAULT_BASE_BRANCH: Record<WorkerType, string> = {
  fe: 'staging',
  qa: 'staging',
  be: 'main',
};

export interface HermesJob {
  jobId: string;
  kind: JobKind;
  type: WorkerType;
  status: JobStatus;
  repo: string;
  baseBranch: string;
  prompt: string;
  source: string;
  channel?: string;
  threadTs?: string;
  requestedBy?: string;
  parentJobId?: string;
  prNumber?: number;
  prUrl?: string;
  headBranch?: string;
  headSha?: string;
  issueKey?: string;
  feedbackSummary?: string;
  qaPlanUri?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt: number;
  error?: string;
}

export interface CreateJobInput {
  jobId?: string;
  kind?: JobKind;
  type: WorkerType;
  repo: string;
  prompt: string;
  source: string;
  baseBranch?: string;
  channel?: string;
  threadTs?: string;
  requestedBy?: string;
  parentJobId?: string;
  prNumber?: number;
  prUrl?: string;
  headBranch?: string;
  headSha?: string;
  issueKey?: string;
  feedbackSummary?: string;
  qaPlanUri?: string;
}

export async function createJob(input: CreateJobInput): Promise<HermesJob> {
  const jobId = input.jobId ?? randomUUID();
  const now = new Date();
  const job: HermesJob = {
    jobId,
    kind: input.kind ?? 'implementation',
    type: input.type,
    status: 'queued',
    repo: input.repo,
    baseBranch: input.baseBranch ?? DEFAULT_BASE_BRANCH[input.type] ?? 'main',
    prompt: input.prompt,
    source: input.source,
    channel: input.channel,
    threadTs: input.threadTs,
    requestedBy: input.requestedBy,
    parentJobId: input.parentJobId,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    headBranch: input.headBranch,
    headSha: input.headSha,
    issueKey: input.issueKey,
    feedbackSummary: input.feedbackSummary,
    qaPlanUri: input.qaPlanUri,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 30 * 24 * 3600, // 30d TTL
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: job }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE,
      MessageBody: JSON.stringify({ jobId, type: job.type }),
    })
  );
  return job;
}

export async function getJob(jobId: string): Promise<HermesJob | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
  return res.Item as HermesJob | undefined;
}

export async function updateJob(
  jobId: string,
  status: JobStatus,
  extra: Record<string, string | number> = {}
): Promise<void> {
  const sets: string[] = ['#s = :s', 'updatedAt = :u'];
  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, string | number> = { ':s': status, ':u': new Date().toISOString() };
  let i = 0;
  for (const [key, value] of Object.entries(extra)) {
    const nameKey = `#k${i}`;
    const valueKey = `:v${i}`;
    names[nameKey] = key;
    values[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
    i++;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}
