/**
 * Distributed comment-event leases shared by Jira Automation callbacks and the direct fast poller.
 * Jira comment ids are immutable, so a delayed webhook can safely arrive after polling without
 * refining a plan twice or creating a second job for the same `/go` command.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { JiraCommentEvent } from './jira.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.JOBS_TABLE!;
const CLAIM_LEASE_SECONDS = Number(process.env.JIRA_COMMENT_CLAIM_LEASE_SECONDS ?? 300);

export interface JiraCommentClaim {
  markerKey: string;
  token: string;
}

function markerKey(event: JiraCommentEvent): string {
  return `jiracomment:${event.issueKey.toUpperCase()}:${event.eventId}`;
}

function isConditionalFailure(err: unknown): boolean {
  return (
    err instanceof ConditionalCheckFailedException ||
    (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException'
  );
}

export async function tryClaimJiraComment(event: JiraCommentEvent): Promise<JiraCommentClaim | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const token = randomUUID();
  const key = markerKey(event);
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          jobId: key,
          commentState: 'processing',
          issueKey: event.issueKey,
          commentId: event.eventId,
          commentCreatedAt: event.createdAt,
          commentPhase: event.phase,
          claimToken: token,
          leaseUntil: now + CLAIM_LEASE_SECONDS,
          updatedAt: new Date().toISOString(),
          expiresAt: now + 30 * 24 * 3600,
        },
        ConditionExpression: 'attribute_not_exists(jobId) OR (commentState = :processing AND leaseUntil < :now)',
        ExpressionAttributeValues: { ':processing': 'processing', ':now': now },
      })
    );
    return { markerKey: key, token };
  } catch (err) {
    if (isConditionalFailure(err)) return undefined;
    throw err;
  }
}

export async function completeJiraCommentClaim(claim: JiraCommentClaim): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: claim.markerKey },
      UpdateExpression:
        'SET commentState = :done, processedAt = :updated, updatedAt = :updated, expiresAt = :expires REMOVE claimToken, leaseUntil',
      ConditionExpression: 'claimToken = :token',
      ExpressionAttributeValues: {
        ':done': 'done',
        ':updated': new Date().toISOString(),
        ':expires': now + 30 * 24 * 3600,
        ':token': claim.token,
      },
    })
  );
}

export async function releaseJiraCommentClaim(claim: JiraCommentClaim): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { jobId: claim.markerKey },
        ConditionExpression: 'claimToken = :token',
        ExpressionAttributeValues: { ':token': claim.token },
      })
    );
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
  }
}
