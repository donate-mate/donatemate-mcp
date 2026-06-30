/**
 * Conversation store. Hermes persists the dialog itself (in the jobs table under synthetic
 * keys) rather than re-reading Slack — so context survives regardless of channel membership,
 * private channels, or history scopes. Two record kinds:
 *   convo:<channel>:<threadTs>   → { messages: [{role,content}] }  (the dialog)
 *   convoptr:<channel>:<user>    → { threadTs }                    (user's active thread, for /start)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.JOBS_TABLE!;
const ttl = () => Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

export interface StoredMsg {
  role: 'user' | 'assistant';
  content: string;
}

const convoKey = (channel: string, threadTs: string) => `convo:${channel}:${threadTs}`;
const ptrKey = (channel: string, user: string) => `convoptr:${channel}:${user}`;

export async function appendMessage(channel: string, threadTs: string, msg: StoredMsg): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: convoKey(channel, threadTs) },
      UpdateExpression:
        'SET #m = list_append(if_not_exists(#m, :empty), :new), #s = :s, updatedAt = :u, expiresAt = :e',
      ExpressionAttributeNames: { '#m': 'messages', '#s': 'status' },
      ExpressionAttributeValues: {
        ':empty': [],
        ':new': [msg],
        ':s': 'convo',
        ':u': new Date().toISOString(),
        ':e': ttl(),
      },
    })
  );
}

export async function getConversation(channel: string, threadTs: string): Promise<StoredMsg[]> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId: convoKey(channel, threadTs) } }));
  return (r.Item?.messages as StoredMsg[]) ?? [];
}

export async function setActivePointer(channel: string, user: string, threadTs: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { jobId: ptrKey(channel, user), status: 'convoptr', threadTs, expiresAt: ttl() },
    })
  );
}

export async function getActivePointer(channel: string, user: string): Promise<string | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId: ptrKey(channel, user) } }));
  return r.Item?.threadTs as string | undefined;
}
