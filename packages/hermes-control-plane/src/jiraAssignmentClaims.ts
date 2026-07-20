/**
 * Distributed, per-assignment leases for Jira intake.
 *
 * The control plane normally has two replicas. Both replicas run the Jira reconciliation sweep,
 * so a stable changelog id plus a conditional DynamoDB write is required to ensure an assignment
 * produces exactly one plan/comment. A short lease makes a claim recoverable if a task dies while
 * planning; completed event markers live longer than the reconciliation lookback window.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { JiraAssignmentEvent } from './jira.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.JOBS_TABLE!;
const CLAIM_LEASE_SECONDS = Number(process.env.JIRA_ASSIGNMENT_CLAIM_LEASE_SECONDS ?? 600);

export interface JiraAssignmentClaim {
  markerKey: string;
  token: string;
}

function markerKey(event: JiraAssignmentEvent): string {
  return `jiraassignment:${event.issueKey.toUpperCase()}:${event.eventId}`;
}

function isConditionalFailure(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException || (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

export async function tryClaimJiraAssignment(event: JiraAssignmentEvent): Promise<JiraAssignmentClaim | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const token = randomUUID();
  const key = markerKey(event);
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          jobId: key,
          assignmentState: 'processing',
          issueKey: event.issueKey,
          assignmentEventId: event.eventId,
          assignedAt: event.assignedAt,
          claimToken: token,
          leaseUntil: now + CLAIM_LEASE_SECONDS,
          updatedAt: new Date().toISOString(),
          expiresAt: now + 30 * 24 * 3600,
        },
        ConditionExpression:
          'attribute_not_exists(jobId) OR (assignmentState = :processing AND leaseUntil < :now)',
        ExpressionAttributeValues: { ':processing': 'processing', ':now': now },
      })
    );
    return { markerKey: key, token };
  } catch (err) {
    if (isConditionalFailure(err)) return undefined;
    throw err;
  }
}

export async function completeJiraAssignmentClaim(claim: JiraAssignmentClaim): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { jobId: claim.markerKey },
      UpdateExpression:
        'SET assignmentState = :done, processedAt = :updated, updatedAt = :updated, expiresAt = :expires REMOVE claimToken, leaseUntil',
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

export async function releaseJiraAssignmentClaim(claim: JiraAssignmentClaim): Promise<void> {
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
    // A newer replica may have reclaimed an expired lease. Never delete its claim.
    if (!isConditionalFailure(err)) throw err;
  }
}
