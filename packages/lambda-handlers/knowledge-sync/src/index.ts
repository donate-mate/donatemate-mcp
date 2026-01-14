/**
 * Knowledge Base Sync Handler
 *
 * Scheduled Lambda that periodically syncs content from integrations.
 * Runs hourly to catch any changes missed by webhooks.
 */

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { ScheduledEvent, Handler } from 'aws-lambda';

// Direct invocation event for on-demand sync
interface DirectSyncEvent {
  integrationId?: string;
  fullSync?: boolean;
}

const dynamoClient = new DynamoDBClient({});
const secretsClient = new SecretsManagerClient({});
const sqsClient = new SQSClient({});

// Cache secrets
const secretsCache: Map<string, { value: Record<string, string>; expiry: number }> = new Map();

interface Integration {
  integrationId: string;
  integrationType: 'github' | 'jira' | 'confluence' | 'slack';
  enabled: boolean;
  config: Record<string, unknown>;
  lastSyncAt?: string;
  createdAt: string;
}

interface SyncEvent {
  source: string;
  eventType: string;
  externalId: string;
  projectKey?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Secret Management
// ---------------------------------------------------------------------------

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
    expiry: Date.now() + 5 * 60 * 1000,
  });

  return value;
}

// ---------------------------------------------------------------------------
// Integration Loading
// ---------------------------------------------------------------------------

async function getEnabledIntegrations(): Promise<Integration[]> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) {
    throw new Error('INTEGRATIONS_TABLE_NAME not configured');
  }

  const result = await dynamoClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'enabled = :enabled',
      ExpressionAttributeValues: {
        ':enabled': { BOOL: true },
      },
    })
  );

  return (result.Items || []).map((item) => ({
    integrationId: item.integrationId?.S || '',
    integrationType: item.integrationType?.S as Integration['integrationType'],
    enabled: item.enabled?.BOOL || false,
    config: JSON.parse(item.config?.S || '{}'),
    lastSyncAt: item.lastSyncAt?.S,
    createdAt: item.createdAt?.S || '',
  }));
}

async function updateLastSync(integrationId: string): Promise<void> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) return;

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        integrationId: { S: integrationId },
      },
      UpdateExpression: 'SET lastSyncAt = :now',
      ExpressionAttributeValues: {
        ':now': { S: new Date().toISOString() },
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Sync Logic by Integration Type
// ---------------------------------------------------------------------------

// File patterns to index from GitHub repos
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

// Max file size to fetch (100KB)
const MAX_FILE_SIZE = 100 * 1024;

async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
  token: string
): Promise<{ content: string; sha: string } | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      console.warn('GitHub file fetch error', { path, status: response.status });
      return null;
    }

    const data = await response.json();

    // Skip if too large or not a file
    if (data.type !== 'file' || data.size > MAX_FILE_SIZE) {
      return null;
    }

    // Content is base64 encoded
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha };
  } catch (error) {
    console.warn('GitHub file fetch failed', { path, error });
    return null;
  }
}

async function fetchGitHubTree(
  owner: string,
  repo: string,
  token: string
): Promise<Array<{ path: string; type: string; size?: number }>> {
  try {
    // Get default branch first
    const repoResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!repoResponse.ok) return [];

    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch || 'main';

    // Get full tree
    const treeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!treeResponse.ok) return [];

    const treeData = await treeResponse.json();
    return treeData.tree || [];
  } catch (error) {
    console.warn('GitHub tree fetch failed', { owner, repo, error });
    return [];
  }
}

function shouldIndexFile(path: string): boolean {
  return GITHUB_DOC_PATTERNS.some(pattern => pattern.test(path));
}

async function syncGitHub(
  integration: Integration,
  since: Date
): Promise<SyncEvent[]> {
  const secretArn = process.env.GITHUB_SECRET_ARN;
  if (!secretArn) return [];

  const secrets = await getSecret(secretArn);
  const token = secrets.token;
  if (!token) return [];

  const events: SyncEvent[] = [];
  const config = integration.config as {
    repos?: Array<{ owner: string; repo: string }>;
  };

  const isFullSync = since.getTime() === 0;

  // For each configured repository
  for (const repo of config.repos || []) {
    const repoKey = `${repo.owner}/${repo.repo}`;

    try {
      // For full sync, fetch all documentation files
      if (isFullSync) {
        console.info('Fetching repo tree for full sync', { repo: repoKey });

        const tree = await fetchGitHubTree(repo.owner, repo.repo, token);
        const filesToIndex = tree.filter(
          item => item.type === 'blob' && shouldIndexFile(item.path) && (item.size || 0) <= MAX_FILE_SIZE
        );

        console.info('Found files to index', { repo: repoKey, count: filesToIndex.length });

        for (const file of filesToIndex) {
          const fileData = await fetchGitHubFile(repo.owner, repo.repo, file.path, token);

          if (fileData) {
            events.push({
              source: 'github',
              eventType: 'file',
              externalId: `${repoKey}:file:${file.path}`,
              projectKey: repoKey,
              payload: {
                path: file.path,
                content: fileData.content,
                sha: fileData.sha,
                type: file.path.endsWith('.md') ? 'markdown' :
                      file.path.endsWith('.json') ? 'json' : 'text',
              },
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // Fetch recent commits
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?since=${since.toISOString()}&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (!response.ok) {
        console.warn('GitHub API error', {
          repo: repoKey,
          status: response.status,
        });
        continue;
      }

      const commits = await response.json();

      // For incremental sync, check if any commits modified doc files
      const modifiedDocFiles = new Set<string>();

      if (!isFullSync && commits.length > 0) {
        // Fetch details for each commit to see which files changed
        for (const commit of commits.slice(0, 20)) { // Limit to 20 commits to avoid API rate limits
          try {
            const commitResponse = await fetch(
              `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${commit.sha}`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/vnd.github.v3+json',
                },
              }
            );

            if (commitResponse.ok) {
              const commitData = await commitResponse.json();
              const files = commitData.files || [];

              for (const file of files) {
                if (shouldIndexFile(file.filename) && file.status !== 'removed') {
                  modifiedDocFiles.add(file.filename);
                }
              }
            }
          } catch {
            // Continue on individual commit fetch errors
          }
        }

        // Queue file_changed events for modified doc files
        for (const filePath of modifiedDocFiles) {
          events.push({
            source: 'github',
            eventType: 'file_changed',
            externalId: `${repoKey}:file:${filePath}`,
            projectKey: repoKey,
            payload: {
              path: filePath,
              action: 'fetch',
            },
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Queue commit events
      for (const commit of commits) {
        events.push({
          source: 'github',
          eventType: 'push',
          externalId: `${repoKey}:${commit.sha}`,
          projectKey: repoKey,
          payload: {
            sha: commit.sha,
            message: commit.commit?.message,
            author: commit.commit?.author?.name,
          },
          timestamp: commit.commit?.committer?.date || new Date().toISOString(),
        });
      }

      console.info('GitHub repo sync completed', {
        repo: repoKey,
        commits: commits.length,
        files: isFullSync ? events.filter(e => e.eventType === 'file').length : 0,
        modifiedDocFiles: modifiedDocFiles.size,
      });
    } catch (error) {
      console.error('GitHub sync error', {
        repo: repoKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return events;
}

async function syncJira(
  integration: Integration,
  since: Date
): Promise<SyncEvent[]> {
  const secretArn = process.env.JIRA_SECRET_ARN;
  if (!secretArn) return [];

  const secrets = await getSecret(secretArn);
  const { email, token, host } = secrets;
  if (!email || !token || !host) return [];

  const events: SyncEvent[] = [];
  const config = integration.config as { projects?: string[] };

  for (const project of config.projects || []) {
    try {
      const jql = `project = ${project} AND updated >= "${since.toISOString().split('T')[0]}" ORDER BY updated DESC`;

      // Use the new /rest/api/3/search/jql endpoint (POST method)
      const response = await fetch(
        `${host}/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jql,
            maxResults: 100,
            fields: ['summary', 'status', 'issuetype', 'updated'],
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('Jira API error', { project, status: response.status, error: errorText });
        continue;
      }

      const data = await response.json();

      for (const issue of data.issues || []) {
        events.push({
          source: 'jira',
          eventType: 'updated',
          externalId: issue.key,
          projectKey: project,
          payload: {
            summary: issue.fields?.summary,
            status: issue.fields?.status?.name,
            issueType: issue.fields?.issuetype?.name,
          },
          timestamp: issue.fields?.updated || new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Jira sync error', {
        project,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return events;
}

async function syncConfluence(
  integration: Integration,
  since: Date
): Promise<SyncEvent[]> {
  const secretArn = process.env.CONFLUENCE_SECRET_ARN;
  if (!secretArn) return [];

  const secrets = await getSecret(secretArn);
  const { email, token, host } = secrets;
  if (!email || !token || !host) return [];

  const events: SyncEvent[] = [];
  const config = integration.config as { spaces?: string[] };

  for (const space of config.spaces || []) {
    try {
      const cql = encodeURIComponent(
        `space = "${space}" AND lastModified >= "${since.toISOString().split('T')[0]}"`
      );

      const response = await fetch(
        `${host}/wiki/rest/api/content/search?cql=${cql}&limit=100`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        console.warn('Confluence API error', { space, status: response.status });
        continue;
      }

      const data = await response.json();

      for (const page of data.results || []) {
        events.push({
          source: 'confluence',
          eventType: 'updated',
          externalId: page.id,
          projectKey: space,
          payload: {
            title: page.title,
            type: page.type,
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Confluence sync error', {
        space,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return events;
}

async function syncSlack(
  integration: Integration,
  since: Date
): Promise<SyncEvent[]> {
  const secretArn = process.env.SLACK_SECRET_ARN;
  if (!secretArn) {
    console.warn('SLACK_SECRET_ARN not configured');
    return [];
  }

  const secrets = await getSecret(secretArn);
  const token = secrets.botToken || secrets.token;
  if (!token) {
    console.warn('Slack bot token not found in secret');
    return [];
  }

  const events: SyncEvent[] = [];
  const config = integration.config as { channels?: string[] };
  const isFullSync = since.getTime() === 0;

  // Convert since to Unix timestamp (Slack uses seconds)
  const oldestTs = isFullSync ? undefined : Math.floor(since.getTime() / 1000).toString();

  // Fetch user mapping (user ID -> display name)
  const userNameMap: Record<string, string> = {};
  try {
    const usersResponse = await fetch(
      'https://slack.com/api/users.list',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const usersData = await usersResponse.json();
    if (usersData.ok && usersData.members) {
      for (const member of usersData.members) {
        if (!member.deleted) {
          const displayName = member.profile?.display_name || member.real_name || member.name || member.id;
          userNameMap[member.id] = displayName;
        }
      }
      console.info('Fetched Slack users', { count: Object.keys(userNameMap).length });
    } else if (usersData.error === 'missing_scope') {
      console.warn('Slack users:read scope not available, user names will not be resolved');
    }
  } catch (error) {
    console.warn('Failed to fetch Slack users', { error });
  }

  // If no channels configured, fetch channels the bot is in
  let channelIds = config.channels || [];

  if (channelIds.length === 0) {
    try {
      const channelsResponse = await fetch(
        'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const channelsData = await channelsResponse.json();
      console.info('Slack conversations.list response', {
        ok: channelsData.ok,
        error: channelsData.error,
        channelCount: channelsData.channels?.length,
        memberChannels: channelsData.channels?.filter((c: any) => c.is_member).length,
      });

      if (channelsData.ok && channelsData.channels) {
        // Only get channels the bot is a member of
        channelIds = channelsData.channels
          .filter((c: any) => c.is_member)
          .map((c: any) => c.id);
        console.info('Found Slack channels bot is member of', { count: channelIds.length, channelIds });
      } else if (channelsData.error) {
        console.error('Slack API error', { error: channelsData.error });
      }
    } catch (error) {
      console.error('Failed to list Slack channels', { error });
      return [];
    }
  }

  // Fetch messages from each channel
  for (const channelId of channelIds) {
    try {
      let cursor: string | undefined;
      let messageCount = 0;
      const maxMessages = isFullSync ? 1000 : 200; // Limit messages per channel

      do {
        const params = new URLSearchParams({
          channel: channelId,
          limit: '100',
        });
        if (oldestTs) params.set('oldest', oldestTs);
        if (cursor) params.set('cursor', cursor);

        const response = await fetch(
          `https://slack.com/api/conversations.history?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const data = await response.json();

        if (!data.ok) {
          console.warn('Slack API error', {
            channel: channelId,
            error: data.error,
          });
          break;
        }

        for (const message of data.messages || []) {
          // Skip bot messages and system messages
          if (message.subtype && message.subtype !== 'thread_broadcast') {
            continue;
          }

          // Build content text from message, files, and attachments
          let messageText = message.text || '';

          // Extract file information if message has files
          if (message.files && Array.isArray(message.files) && message.files.length > 0) {
            const fileDescriptions = message.files
              .map((f: any) => `[File: ${f.title || f.name || 'attachment'}]`)
              .join(' ');
            messageText = messageText ? `${messageText} ${fileDescriptions}` : fileDescriptions;
          }

          // Extract attachment text (link previews, etc.)
          if (message.attachments && Array.isArray(message.attachments)) {
            for (const att of message.attachments) {
              if (att.text) {
                messageText = messageText ? `${messageText}\n${att.text}` : att.text;
              } else if (att.title) {
                messageText = messageText ? `${messageText} [${att.title}]` : `[${att.title}]`;
              }
            }
          }

          // Skip messages with no extractable content
          if (!messageText.trim()) {
            continue;
          }

          // Resolve user name from ID
          const userName = userNameMap[message.user] || message.user;

          events.push({
            source: 'slack',
            eventType: 'message',
            externalId: `${channelId}:${message.ts}`,
            projectKey: channelId,
            payload: {
              channel: channelId,
              ts: message.ts,
              threadTs: message.thread_ts,
              user: message.user,
              userName: userName,
              text: messageText,
              replyCount: message.reply_count,
            },
            timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
          });

          messageCount++;

          // Fetch thread replies if this message has replies
          if (message.reply_count && message.reply_count > 0) {
            try {
              const repliesParams = new URLSearchParams({
                channel: channelId,
                ts: message.ts,
                limit: '100',
              });

              const repliesResponse = await fetch(
                `https://slack.com/api/conversations.replies?${repliesParams}`,
                {
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                  },
                }
              );

              const repliesData = await repliesResponse.json();

              if (repliesData.ok && repliesData.messages) {
                // Skip the first message (it's the parent we already indexed)
                for (const reply of repliesData.messages.slice(1)) {
                  // Skip bot messages and system messages
                  if (reply.subtype) {
                    continue;
                  }

                  // Build content text from reply
                  let replyText = reply.text || '';

                  // Extract file information
                  if (reply.files && Array.isArray(reply.files) && reply.files.length > 0) {
                    const fileDescriptions = reply.files
                      .map((f: any) => `[File: ${f.title || f.name || 'attachment'}]`)
                      .join(' ');
                    replyText = replyText ? `${replyText} ${fileDescriptions}` : fileDescriptions;
                  }

                  // Extract attachment text
                  if (reply.attachments && Array.isArray(reply.attachments)) {
                    for (const att of reply.attachments) {
                      if (att.text) {
                        replyText = replyText ? `${replyText}\n${att.text}` : att.text;
                      } else if (att.title) {
                        replyText = replyText ? `${replyText} [${att.title}]` : `[${att.title}]`;
                      }
                    }
                  }

                  // Skip replies with no content
                  if (!replyText.trim()) {
                    continue;
                  }

                  const replyUserName = userNameMap[reply.user] || reply.user;

                  events.push({
                    source: 'slack',
                    eventType: 'message',
                    externalId: `${channelId}:${reply.ts}`,
                    projectKey: channelId,
                    payload: {
                      channel: channelId,
                      ts: reply.ts,
                      threadTs: message.ts, // Reference to parent thread
                      user: reply.user,
                      userName: replyUserName,
                      text: replyText,
                      isThreadReply: true,
                    },
                    timestamp: new Date(parseFloat(reply.ts) * 1000).toISOString(),
                  });

                  messageCount++;
                }
              }

              // Rate limit for replies API
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (replyError) {
              console.warn('Failed to fetch thread replies', {
                channel: channelId,
                threadTs: message.ts,
                error: replyError instanceof Error ? replyError.message : String(replyError),
              });
            }
          }
        }

        cursor = data.response_metadata?.next_cursor;

        // Rate limit: Slack allows ~50 requests per minute for this endpoint
        if (cursor) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } while (cursor && messageCount < maxMessages);

      console.info('Slack channel sync completed', {
        channel: channelId,
        messages: messageCount,
      });
    } catch (error) {
      console.error('Slack channel sync error', {
        channel: channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.info('Slack sync completed', {
    channels: channelIds.length,
    totalMessages: events.length,
    isFullSync,
  });

  return events;
}

// ---------------------------------------------------------------------------
// Queue Events
// ---------------------------------------------------------------------------

async function queueEvents(events: SyncEvent[]): Promise<void> {
  const queueUrl = process.env.INDEX_QUEUE_URL;
  if (!queueUrl || events.length === 0) return;

  // Send in batches of 10 (SQS limit)
  const batches = [];
  for (let i = 0; i < events.length; i += 10) {
    batches.push(events.slice(i, i + 10));
  }

  for (const batch of batches) {
    await sqsClient.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((event, index) => ({
          Id: `${index}`,
          MessageBody: JSON.stringify(event),
          MessageAttributes: {
            source: {
              DataType: 'String',
              StringValue: event.source,
            },
          },
        })),
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Single Integration Sync
// ---------------------------------------------------------------------------

async function getIntegration(integrationId: string): Promise<Integration | null> {
  const tableName = process.env.INTEGRATIONS_TABLE_NAME;
  if (!tableName) return null;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { integrationId: { S: integrationId } },
    })
  );

  if (!result.Item) return null;

  return {
    integrationId: result.Item.integrationId?.S || '',
    integrationType: result.Item.integrationType?.S as Integration['integrationType'],
    enabled: result.Item.enabled?.BOOL || false,
    config: JSON.parse(result.Item.config?.S || '{}'),
    lastSyncAt: result.Item.lastSyncAt?.S,
    createdAt: result.Item.createdAt?.S || '',
  };
}

async function syncIntegration(integration: Integration, fullSync: boolean): Promise<number> {
  // For full sync, use epoch; otherwise use last sync or 1 hour ago
  const since = fullSync
    ? new Date(0) // Epoch - get all content
    : integration.lastSyncAt
      ? new Date(integration.lastSyncAt)
      : new Date(Date.now() - 60 * 60 * 1000);

  console.info('Syncing integration', {
    id: integration.integrationId,
    type: integration.integrationType,
    fullSync,
    since: since.toISOString(),
  });

  let events: SyncEvent[] = [];

  switch (integration.integrationType) {
    case 'github':
      events = await syncGitHub(integration, since);
      break;
    case 'jira':
      events = await syncJira(integration, since);
      break;
    case 'confluence':
      events = await syncConfluence(integration, since);
      break;
    case 'slack':
      events = await syncSlack(integration, since);
      break;
  }

  if (events.length > 0) {
    await queueEvents(events);
    console.info('Queued sync events', {
      integration: integration.integrationId,
      count: events.length,
    });
  }

  // Update last sync timestamp
  await updateLastSync(integration.integrationId);

  return events.length;
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

export async function handler(event: ScheduledEvent | DirectSyncEvent): Promise<void> {
  // Check if this is a direct invocation with integrationId
  const directEvent = event as DirectSyncEvent;
  if (directEvent.integrationId) {
    console.info('Starting on-demand sync', {
      integrationId: directEvent.integrationId,
      fullSync: directEvent.fullSync,
    });

    const integration = await getIntegration(directEvent.integrationId);
    if (!integration) {
      throw new Error(`Integration not found: ${directEvent.integrationId}`);
    }

    if (!integration.enabled) {
      console.warn('Integration is disabled, skipping sync');
      return;
    }

    const count = await syncIntegration(integration, directEvent.fullSync || false);
    console.info('On-demand sync completed', { totalEvents: count });
    return;
  }

  // Scheduled event - sync all integrations
  const scheduledEvent = event as ScheduledEvent;
  console.info('Starting scheduled sync', { time: scheduledEvent.time });

  try {
    // Get all enabled integrations
    const integrations = await getEnabledIntegrations();
    console.info('Found integrations', { count: integrations.length });

    let totalEvents = 0;

    for (const integration of integrations) {
      const count = await syncIntegration(integration, false);
      totalEvents += count;
    }

    console.info('Sync completed', { totalEvents });
  } catch (error) {
    console.error('Sync failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
