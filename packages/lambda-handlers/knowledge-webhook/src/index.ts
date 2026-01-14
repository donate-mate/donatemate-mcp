/**
 * Knowledge Base Webhook Handler
 *
 * Receives webhooks from GitHub, Jira, Confluence, and Slack.
 * Validates webhook signatures and queues events for async processing.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { createHmac, timingSafeEqual } from 'crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const secretsClient = new SecretsManagerClient({});
const sqsClient = new SQSClient({});

// Cache secrets in memory
const secretsCache: Map<string, { value: Record<string, string>; expiry: number }> = new Map();

async function getSecret(secretArn: string): Promise<Record<string, string>> {
  const cached = secretsCache.get(secretArn);
  if (cached && cached.expiry > Date.now()) {
    return cached.value;
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  const value = JSON.parse(response.SecretString || '{}');
  secretsCache.set(secretArn, {
    value,
    expiry: Date.now() + 5 * 60 * 1000, // 5 minute cache
  });

  return value;
}

interface WebhookEvent {
  source: 'github' | 'jira' | 'confluence' | 'slack';
  eventType: string;
  externalId: string;
  projectKey?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// File patterns to detect documentation changes
const GITHUB_DOC_PATTERNS = [
  /^README\.md$/i,
  /^README$/i,
  /^docs\//i,
  /^documentation\//i,
  /^\.github\/.*\.md$/i,
  /^CHANGELOG\.md$/i,
  /^CONTRIBUTING\.md$/i,
  /^LICENSE$/i,
  /^package\.json$/,
  /^tsconfig\.json$/,
];

function isDocFile(path: string): boolean {
  return GITHUB_DOC_PATTERNS.some(pattern => pattern.test(path));
}

// ---------------------------------------------------------------------------
// GitHub Webhook Validation
// ---------------------------------------------------------------------------

async function validateGitHubWebhook(
  body: string,
  signature: string | undefined
): Promise<boolean> {
  if (!signature) return false;

  const secretArn = process.env.GITHUB_SECRET_ARN;
  if (!secretArn) return false;

  const secrets = await getSecret(secretArn);
  const webhookSecret = secrets.webhookSecret;
  if (!webhookSecret) return false;

  const expected =
    'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseGitHubWebhook(
  event: APIGatewayProxyEventV2,
  body: Record<string, unknown>
): WebhookEvent[] {
  const eventType = event.headers['x-github-event'];
  if (!eventType) return [];

  const repo = body.repository as Record<string, unknown> | undefined;
  const repoFullName = repo?.full_name as string | undefined;
  const events: WebhookEvent[] = [];

  if (eventType === 'push') {
    const ref = body.ref as string;
    const commits = body.commits as Array<Record<string, unknown>> || [];

    // Collect all modified doc files from all commits
    const modifiedDocFiles = new Set<string>();
    for (const commit of commits) {
      const added = (commit.added as string[]) || [];
      const modified = (commit.modified as string[]) || [];

      for (const file of [...added, ...modified]) {
        if (isDocFile(file)) {
          modifiedDocFiles.add(file);
        }
      }
    }

    // Queue file fetch events for each modified doc file
    for (const filePath of modifiedDocFiles) {
      events.push({
        source: 'github',
        eventType: 'file_changed',
        externalId: `${repoFullName}:file:${filePath}`,
        projectKey: repoFullName,
        payload: {
          path: filePath,
          action: 'fetch', // Signal to indexer to fetch fresh content
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Also queue the push event for commit indexing
    for (const commit of commits) {
      events.push({
        source: 'github',
        eventType: 'push',
        externalId: `${repoFullName}:${commit.id}`,
        projectKey: repoFullName,
        payload: {
          sha: commit.id,
          message: commit.message,
          author: (commit.author as Record<string, unknown>)?.name,
        },
        timestamp: (commit.timestamp as string) || new Date().toISOString(),
      });
    }

    console.info('GitHub push webhook parsed', {
      repo: repoFullName,
      commits: commits.length,
      docFilesChanged: modifiedDocFiles.size,
    });
  }

  if (eventType === 'pull_request') {
    const pr = body.pull_request as Record<string, unknown>;
    events.push({
      source: 'github',
      eventType: `pull_request_${body.action}`,
      externalId: `${repoFullName}#${pr?.number}`,
      projectKey: repoFullName,
      payload: {
        action: body.action,
        number: pr?.number,
        title: pr?.title,
        state: pr?.state,
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (eventType === 'issues') {
    const issue = body.issue as Record<string, unknown>;
    events.push({
      source: 'github',
      eventType: `issue_${body.action}`,
      externalId: `${repoFullName}#${issue?.number}`,
      projectKey: repoFullName,
      payload: {
        action: body.action,
        number: issue?.number,
        title: issue?.title,
        state: issue?.state,
      },
      timestamp: new Date().toISOString(),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Slack Webhook Validation
// ---------------------------------------------------------------------------

async function validateSlackWebhook(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined
): Promise<boolean> {
  if (!timestamp || !signature) return false;

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return false;
  }

  const secretArn = process.env.SLACK_SECRET_ARN;
  if (!secretArn) return false;

  const secrets = await getSecret(secretArn);
  const signingSecret = secrets.signingSecret;
  if (!signingSecret) return true; // Optional validation

  const sigBase = `v0:${timestamp}:${body}`;
  const expected =
    'v0=' + createHmac('sha256', signingSecret).update(sigBase).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseSlackWebhook(body: Record<string, unknown>): WebhookEvent | null {
  const eventType = body.type as string;

  // URL verification challenge
  if (eventType === 'url_verification') {
    return null; // Handled separately
  }

  if (eventType === 'event_callback') {
    const slackEvent = body.event as Record<string, unknown>;
    const eventSubType = slackEvent?.type as string;

    if (eventSubType === 'message' && !slackEvent.subtype) {
      return {
        source: 'slack',
        eventType: 'message_created',
        externalId: `${slackEvent.channel}:${slackEvent.ts}`,
        projectKey: slackEvent.channel as string,
        payload: {
          channel: slackEvent.channel,
          ts: slackEvent.ts,
          threadTs: slackEvent.thread_ts,
          user: slackEvent.user,
          text: slackEvent.text,
        },
        timestamp: new Date().toISOString(),
      };
    }

    if (eventSubType === 'reaction_added') {
      const item = slackEvent.item as Record<string, unknown>;
      return {
        source: 'slack',
        eventType: 'reaction_added',
        externalId: `${item?.channel}:${item?.ts}`,
        projectKey: item?.channel as string,
        payload: {
          reaction: slackEvent.reaction,
          channel: item?.channel,
          ts: item?.ts,
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Jira Webhook Parsing
// ---------------------------------------------------------------------------

function parseJiraWebhook(body: Record<string, unknown>): WebhookEvent | null {
  const webhookEvent = body.webhookEvent as string;
  if (!webhookEvent?.startsWith('jira:')) return null;

  const issue = body.issue as Record<string, unknown>;
  const fields = issue?.fields as Record<string, unknown>;
  const project = fields?.project as Record<string, unknown>;

  let eventType: string;
  if (webhookEvent === 'jira:issue_created') {
    eventType = 'created';
  } else if (webhookEvent === 'jira:issue_deleted') {
    eventType = 'deleted';
  } else {
    eventType = 'updated';
  }

  return {
    source: 'jira',
    eventType,
    externalId: issue?.key as string,
    projectKey: project?.key as string,
    payload: {
      issueType: (fields?.issuetype as Record<string, unknown>)?.name,
      status: (fields?.status as Record<string, unknown>)?.name,
      summary: fields?.summary,
    },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Confluence Webhook Parsing
// ---------------------------------------------------------------------------

function parseConfluenceWebhook(body: Record<string, unknown>): WebhookEvent | null {
  const eventType = body.eventType as string;
  if (!eventType) return null;

  if (eventType.includes('page')) {
    const page = body.page as Record<string, unknown>;
    let event: string;
    if (eventType === 'page_created') event = 'created';
    else if (eventType === 'page_removed' || eventType === 'page_trashed') event = 'deleted';
    else event = 'updated';

    return {
      source: 'confluence',
      eventType: event,
      externalId: page?.id as string,
      projectKey: page?.spaceKey as string,
      payload: {
        title: page?.title,
        version: (page?.version as Record<string, unknown>)?.number,
      },
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

// Helper to queue multiple events in batches
async function queueEvents(events: WebhookEvent[], queueUrl: string): Promise<void> {
  if (events.length === 0) return;

  // SQS batch limit is 10
  const batches: WebhookEvent[][] = [];
  for (let i = 0; i < events.length; i += 10) {
    batches.push(events.slice(i, i + 10));
  }

  for (const batch of batches) {
    await sqsClient.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((evt, index) => ({
          Id: `${index}`,
          MessageBody: JSON.stringify(evt),
          MessageAttributes: {
            source: {
              DataType: 'String',
              StringValue: evt.source,
            },
            eventType: {
              DataType: 'String',
              StringValue: evt.eventType,
            },
          },
        })),
      })
    );
  }
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;

  // Health check
  if (path === '/health') {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }),
    };
  }

  const body = event.body || '{}';
  let parsedBody: Record<string, unknown>;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  let webhookEvents: WebhookEvent[] = [];

  // Route based on path
  if (path === '/webhook/github') {
    const signature = event.headers['x-hub-signature-256'];
    const isValid = await validateGitHubWebhook(body, signature);
    if (!isValid) {
      console.warn('Invalid GitHub webhook signature');
      return { statusCode: 401, body: 'Invalid signature' };
    }
    webhookEvents = parseGitHubWebhook(event, parsedBody);
  } else if (path === '/webhook/slack') {
    // Handle URL verification challenge
    if (parsedBody.type === 'url_verification') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: parsedBody.challenge as string,
      };
    }

    const timestamp = event.headers['x-slack-request-timestamp'];
    const signature = event.headers['x-slack-signature'];
    const isValid = await validateSlackWebhook(body, timestamp, signature);
    if (!isValid) {
      console.warn('Invalid Slack webhook signature');
      return { statusCode: 401, body: 'Invalid signature' };
    }
    const slackEvent = parseSlackWebhook(parsedBody);
    if (slackEvent) webhookEvents = [slackEvent];
  } else if (path === '/webhook/jira') {
    // Jira Cloud doesn't have built-in signature validation
    const jiraEvent = parseJiraWebhook(parsedBody);
    if (jiraEvent) webhookEvents = [jiraEvent];
  } else if (path === '/webhook/confluence') {
    // Confluence Cloud doesn't have built-in signature validation
    const confluenceEvent = parseConfluenceWebhook(parsedBody);
    if (confluenceEvent) webhookEvents = [confluenceEvent];
  } else {
    return { statusCode: 404, body: 'Not found' };
  }

  // If no events parsed, just acknowledge
  if (webhookEvents.length === 0) {
    return { statusCode: 200, body: 'OK' };
  }

  // Queue events for async processing
  const queueUrl = process.env.INDEX_QUEUE_URL;
  if (!queueUrl) {
    console.error('INDEX_QUEUE_URL not configured');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  try {
    await queueEvents(webhookEvents, queueUrl);

    console.info('Queued webhook events', {
      source: webhookEvents[0]?.source,
      count: webhookEvents.length,
      eventTypes: [...new Set(webhookEvents.map(e => e.eventType))],
    });

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Failed to queue events', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { statusCode: 500, body: 'Failed to process webhook' };
  }
}
