/**
 * Active-conversation tracking. Slack slash commands don't carry thread_ts, so we remember the
 * thread a user is currently talking to Hermes in (per channel) — `/start` flushes that thread
 * into a coding job. Stored in the jobs table under a synthetic key (no extra table needed).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.JOBS_TABLE!;

const convoKey = (channel: string, user: string) => `convo:${channel}:${user}`;

export async function setActiveThread(channel: string, user: string, threadTs: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        jobId: convoKey(channel, user),
        status: 'convo',
        threadTs,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // 7d TTL
      },
    })
  );
}

export async function getActiveThread(channel: string, user: string): Promise<string | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId: convoKey(channel, user) } }));
  return r.Item?.threadTs as string | undefined;
}
