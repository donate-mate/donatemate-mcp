/**
 * Job state (worker side): update status/result in DynamoDB and store the run transcript in S3.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const TABLE = process.env.JOBS_TABLE!;
const BUCKET = process.env.ARTIFACTS_BUCKET!;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobKind =
  | 'implementation'
  | 'ci_fix'
  | 'review_fix'
  | 'merge_conflict_fix'
  | 'combined_followup'
  | 'deploy_verification'
  | 'qa_proof';

export interface HermesJob {
  jobId: string;
  kind?: JobKind;
  type: 'fe' | 'be' | 'qa';
  status: JobStatus;
  repo: string;
  baseBranch: string;
  prompt: string;
  source: string;
  channel?: string;
  threadTs?: string;
  parentJobId?: string;
  prNumber?: number;
  prUrl?: string;
  headBranch?: string;
  headSha?: string;
  issueKey?: string;
  feedbackSummary?: string;
  qaPlanUri?: string;
  updatedAt?: string;
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
  const sets: string[] = ['#s = :s', '#u = :u'];
  // Alias every attribute name to avoid DynamoDB reserved keywords (e.g. `status`, `error`).
  const names: Record<string, string> = { '#s': 'status', '#u': 'updatedAt' };
  const values: Record<string, string | number> = { ':s': status, ':u': new Date().toISOString() };
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

export async function touchJob(jobId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: 'SET updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':updatedAt': new Date().toISOString(),
      },
    })
  );
}

export interface PrWatchInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  sourceJobId: string;
  type: HermesJob['type'];
  baseBranch: string;
  headBranch: string;
  headSha: string;
  originalPrompt: string;
  issueKey?: string;
  channel?: string;
  threadTs?: string;
}

const prWatchKey = (repo: string, prNumber: number) => `prwatch:${repo}#${prNumber}`;

export async function recordPrWatch(input: PrWatchInput): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: prWatchKey(input.repo, input.prNumber) },
      UpdateExpression: [
        'SET #s = :status',
        'repo = :repo',
        'prNumber = :prNumber',
        'prUrl = :prUrl',
        'sourceJobId = :sourceJobId',
        '#type = :type',
        'baseBranch = :baseBranch',
        'headBranch = :headBranch',
        'headSha = :headSha',
        'originalPrompt = :originalPrompt',
        'issueKey = :issueKey',
        'channel = :channel',
        'threadTs = :threadTs',
        'jiraState = if_not_exists(jiraState, :jiraState)',
        'fixAttemptCount = if_not_exists(fixAttemptCount, :zero)',
        'handledSignalIds = if_not_exists(handledSignalIds, :empty)',
        'createdAt = if_not_exists(createdAt, :now)',
        'updatedAt = :now',
        'expiresAt = :expiresAt',
      ].join(', '),
      ExpressionAttributeNames: { '#s': 'status', '#type': 'type' },
      ExpressionAttributeValues: {
        ':status': 'prwatch:watching',
        ':repo': input.repo,
        ':prNumber': input.prNumber,
        ':prUrl': input.prUrl,
        ':sourceJobId': input.sourceJobId,
        ':type': input.type,
        ':baseBranch': input.baseBranch,
        ':headBranch': input.headBranch,
        ':headSha': input.headSha,
        ':originalPrompt': input.originalPrompt,
        ':issueKey': input.issueKey ?? '',
        ':channel': input.channel ?? '',
        ':threadTs': input.threadTs ?? '',
        ':jiraState': 'pr_open',
        ':zero': 0,
        ':empty': [],
        ':now': now,
        ':expiresAt': Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      },
    })
  );
}

export async function markPrWatchWaiting(repo: string, prNumber: number, headSha: string): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: prWatchKey(repo, prNumber) },
        UpdateExpression:
          'SET #s = :status, jiraState = :jiraState, activeFixJobId = :emptyActive, headSha = :headSha, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'prwatch:watching',
          ':jiraState': 'waiting_ci',
          ':emptyActive': '',
          ':headSha': headSha,
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(jobId)',
      })
    )
    .catch(() => {
      /* PR watch may not exist for older jobs; follow-up still succeeded. */
    });
}

export async function markPrWatchQaRunning(repo: string, prNumber: number): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: prWatchKey(repo, prNumber) },
        UpdateExpression: 'SET #s = :status, jiraState = :jiraState, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'prwatch:qa_running',
          ':jiraState': 'qa_running',
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(jobId)',
      })
    )
    .catch(() => {
      /* older jobs may not have a PR watch */
    });
}

export async function markPrWatchQaDone(repo: string, prNumber: number): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: prWatchKey(repo, prNumber) },
        UpdateExpression: 'SET #s = :status, jiraState = :jiraState, activeQaJobId = :emptyActive, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'prwatch:done',
          ':jiraState': 'qa_passed',
          ':emptyActive': '',
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(jobId)',
      })
    )
    .catch(() => {
      /* older jobs may not have a PR watch */
    });
}

export async function markPrWatchReadyForQa(repo: string, prNumber: number, deployRunUrl?: string): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: prWatchKey(repo, prNumber) },
        UpdateExpression:
          'SET #s = :status, jiraState = :jiraState, activeQaJobId = :emptyActive, deployRunUrl = :deployRunUrl, updatedAt = :updatedAt REMOVE blockReason',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'prwatch:done',
          ':jiraState': 'ready_qa',
          ':emptyActive': '',
          ':deployRunUrl': deployRunUrl ?? '',
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(jobId)',
      })
    )
    .catch(() => {
      /* older jobs may not have a PR watch */
    });
}

export async function markPrWatchQaFailed(repo: string, prNumber: number, reason: string): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: prWatchKey(repo, prNumber) },
        UpdateExpression:
          'SET #s = :status, jiraState = :jiraState, blockReason = :reason, activeQaJobId = :emptyActive, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':status': 'prwatch:blocked',
          ':jiraState': 'qa_failed',
          ':reason': reason.slice(0, 1000),
          ':emptyActive': '',
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(jobId)',
      })
    )
    .catch(() => {
      /* older jobs may not have a PR watch */
    });
}

export async function markFlowRunning(issueKey: string, extra: Record<string, string> = {}): Promise<void> {
  const key = `jiraflow:${issueKey.toUpperCase()}`;
  const sets = ['#s = :s', 'updatedAt = :u'];
  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, string> = { ':s': 'running', ':u': new Date().toISOString() };
  let i = 0;
  for (const [k, v] of Object.entries(extra)) {
    const nk = `#r${i}`;
    const vk = `:r${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
    i++;
  }
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: key },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(jobId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    )
    .catch(() => {
      /* non-Jira jobs do not have flow records */
    });
}

/**
 * Mark a Jira ticket's flow record terminal so the control plane stops reporting "still running".
 * Only updates an existing flow record (jira-sourced jobs) — never creates a stub for Slack/
 * dispatch jobs. Best-effort.
 */
export async function markFlowDone(issueKey: string, extra: Record<string, string> = {}): Promise<void> {
  const key = `jiraflow:${issueKey.toUpperCase()}`;
  const sets = ['#s = :s', 'updatedAt = :u'];
  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, string> = { ':s': 'done', ':u': new Date().toISOString() };
  let i = 0;
  for (const [k, v] of Object.entries(extra)) {
    const nk = `#f${i}`;
    const vk = `:f${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
    i++;
  }
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { jobId: key },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(jobId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    )
    .catch(() => {
      /* no flow record (non-jira job) or already gone — fine */
    });
}

export async function storeTranscript(jobId: string, transcript: string): Promise<string> {
  const key = `jobs/${jobId}/transcript.txt`;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: transcript, ContentType: 'text/plain' })
  );
  return `s3://${BUCKET}/${key}`;
}

export async function storeJsonArtifact(jobId: string, name: string, value: unknown): Promise<string> {
  const key = `jobs/${jobId}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: 'application/json',
    })
  );
  return `s3://${BUCKET}/${key}`;
}
