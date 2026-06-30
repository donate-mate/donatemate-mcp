/**
 * Job state (worker side): update status/result in DynamoDB and store the run transcript in S3.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.JOBS_TABLE!;
const BUCKET = process.env.ARTIFACTS_BUCKET!;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface HermesJob {
  jobId: string;
  type: 'fe' | 'be' | 'qa';
  status: JobStatus;
  repo: string;
  baseBranch: string;
  prompt: string;
  source: string;
  channel?: string;
  threadTs?: string;
}

export async function getJob(jobId: string): Promise<HermesJob | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
  return res.Item as HermesJob | undefined;
}

export async function updateJob(
  jobId: string,
  status: JobStatus,
  extra: Record<string, string> = {}
): Promise<void> {
  const sets: string[] = ['#s = :s', '#u = :u'];
  // Alias every attribute name to avoid DynamoDB reserved keywords (e.g. `status`, `error`).
  const names: Record<string, string> = { '#s': 'status', '#u': 'updatedAt' };
  const values: Record<string, string> = { ':s': status, ':u': new Date().toISOString() };
  let i = 0;
  for (const [k, v] of Object.entries(extra)) {
    const nk = `#k${i}`;
    const vk = `:v${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
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

export async function storeTranscript(jobId: string, transcript: string): Promise<string> {
  const key = `jobs/${jobId}/transcript.txt`;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: transcript, ContentType: 'text/plain' })
  );
  return `s3://${BUCKET}/${key}`;
}
