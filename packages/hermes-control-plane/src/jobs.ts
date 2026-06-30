/**
 * Job intake: write a row to the Hermes jobs table and enqueue it on SQS.
 * The worker pool consumes from the queue and processes each job.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const TABLE = process.env.JOBS_TABLE!;
const QUEUE = process.env.JOBS_QUEUE_URL!;

export type WorkerType = 'fe' | 'be' | 'qa';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// Default branch each worker type targets when a job doesn't specify one. The FE app's `main`
// is a deploy-test skeleton — real code lives on `staging` — so FE/QA default there.
const DEFAULT_BASE_BRANCH: Record<WorkerType, string> = {
  fe: 'staging',
  qa: 'staging',
  be: 'main',
};

export interface HermesJob {
  jobId: string;
  type: WorkerType;
  status: JobStatus;
  repo: string;
  baseBranch: string;
  prompt: string;
  source: string;
  channel?: string;
  threadTs?: string;
  requestedBy?: string;
  createdAt: string;
  expiresAt: number;
  prUrl?: string;
  error?: string;
}

export interface CreateJobInput {
  type: WorkerType;
  repo: string;
  prompt: string;
  source: string;
  baseBranch?: string;
  channel?: string;
  threadTs?: string;
  requestedBy?: string;
}

export async function createJob(input: CreateJobInput): Promise<HermesJob> {
  const jobId = randomUUID();
  const now = new Date();
  const job: HermesJob = {
    jobId,
    type: input.type,
    status: 'queued',
    repo: input.repo,
    baseBranch: input.baseBranch ?? DEFAULT_BASE_BRANCH[input.type] ?? 'main',
    prompt: input.prompt,
    source: input.source,
    channel: input.channel,
    threadTs: input.threadTs,
    requestedBy: input.requestedBy,
    createdAt: now.toISOString(),
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
