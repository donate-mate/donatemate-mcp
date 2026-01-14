/**
 * Slack Integration Plugin
 * Indexes important messages and threads
 */

import { WebClient } from '@slack/web-api';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { BasePlugin } from '../core/base-plugin.js';
import type {
  IntegrationConfig,
  HealthStatus,
  WebhookRequest,
  IntegrationEvent,
  ContentChunk,
  ExternalReference,
} from '../../types/index.js';

const configSchema = z.object({
  workspace: z.string().optional(),
  channels: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()).optional(),
  }),
  indexing: z
    .object({
      minReactions: z.number().optional().default(0),
      includeThreads: z.boolean().optional().default(true),
      maxAgeDays: z.number().optional().default(365),
    })
    .optional(),
  secrets: z.object({
    botToken: z.string(),
    signingSecret: z.string().optional(),
  }),
});

type SlackConfig = z.infer<typeof configSchema>;

// Keywords that indicate important messages
const IMPORTANT_KEYWORDS = [
  'decision',
  'decided',
  'agreed',
  'approved',
  'shipped',
  'launched',
  'released',
  'deployed',
  'bug',
  'fix',
  'breaking',
  'important',
  'urgent',
  'todo',
  'action item',
  'fyi',
  'announcement',
];

export class SlackPlugin extends BasePlugin {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  readonly version = '1.0.0';
  readonly configSchema = configSchema;

  private client: WebClient | null = null;
  private signingSecret: string | null = null;
  private workspace: string = '';
  private includeChannels: string[] = [];
  private excludeChannels: string[] = [];
  private minReactions: number = 0;
  private includeThreads: boolean = true;
  private maxAgeDays: number = 365;
  private channelMap: Map<string, string> = new Map(); // id -> name

  protected async onInitialize(config: IntegrationConfig): Promise<void> {
    const parsed = configSchema.parse(config.config) as SlackConfig;

    this.client = new WebClient(parsed.secrets.botToken);
    this.signingSecret = parsed.secrets.signingSecret ?? null;
    this.workspace = parsed.workspace ?? 'donatemate';
    this.includeChannels = parsed.channels.include;
    this.excludeChannels = parsed.channels.exclude ?? [];
    this.minReactions = parsed.indexing?.minReactions ?? 0;
    this.includeThreads = parsed.indexing?.includeThreads ?? true;
    this.maxAgeDays = parsed.indexing?.maxAgeDays ?? 365;

    // Load channel list
    await this.loadChannels();

    this.log('info', `Initialized for ${this.channelMap.size} channels`);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      this.ensureInitialized();
      const result = await this.client!.auth.test();

      return {
        healthy: true,
        message: `Connected to ${result.team} as ${result.user}`,
        lastCheck: new Date(),
        details: {
          team: result.team,
          user: result.user,
          botId: result.bot_id,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        lastCheck: new Date(),
      };
    }
  }

  async validateWebhook(request: WebhookRequest): Promise<boolean> {
    if (!this.signingSecret) return true;

    const timestamp = request.headers['x-slack-request-timestamp'];
    const signature = request.headers['x-slack-signature'];

    if (!timestamp || !signature) return false;

    // Check timestamp is within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
      return false;
    }

    const body =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    const sigBase = `v0:${timestamp}:${body}`;
    const expected =
      'v0=' + createHmac('sha256', this.signingSecret).update(sigBase).digest('hex');

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]> {
    const payload =
      typeof request.body === 'string'
        ? JSON.parse(request.body)
        : request.body;

    const events: IntegrationEvent[] = [];

    // Handle URL verification challenge
    if (payload.type === 'url_verification') {
      return events; // Handled separately
    }

    if (payload.type === 'event_callback') {
      const event = payload.event;

      if (event.type === 'message' && !event.subtype) {
        // Only index if message meets criteria
        if (this.shouldIndex(event)) {
          events.push({
            eventType: 'created',
            externalId: `${event.channel}:${event.ts}`,
            sourceType: 'slack',
            timestamp: new Date(parseFloat(event.ts) * 1000),
            projectKey: this.channelMap.get(event.channel) || event.channel,
            payload: {
              channel: event.channel,
              ts: event.ts,
              threadTs: event.thread_ts,
              user: event.user,
            },
          });
        }
      } else if (event.type === 'reaction_added') {
        // Re-index message when reaction is added
        events.push({
          eventType: 'updated',
          externalId: `${event.item.channel}:${event.item.ts}`,
          sourceType: 'slack',
          timestamp: new Date(),
          projectKey: this.channelMap.get(event.item.channel) || event.item.channel,
          payload: {
            reaction: event.reaction,
            channel: event.item.channel,
            ts: event.item.ts,
          },
        });
      } else if (event.type === 'pin_added') {
        events.push({
          eventType: 'updated',
          externalId: `${event.channel_id}:${event.item.message.ts}`,
          sourceType: 'slack',
          timestamp: new Date(),
          projectKey: this.channelMap.get(event.channel_id) || event.channel_id,
          payload: {
            pinned: true,
          },
        });
      }
    }

    return events;
  }

  async fetchItem(externalId: string): Promise<ContentChunk[]> {
    this.ensureInitialized();

    const [channelId, ts] = externalId.split(':');

    try {
      // Get the message
      const result = await this.client!.conversations.history({
        channel: channelId,
        latest: ts,
        limit: 1,
        inclusive: true,
      });

      if (!result.messages || result.messages.length === 0) {
        return [];
      }

      const message = result.messages[0];
      const chunks = await this.messageToChunks(message, channelId);

      // Get thread replies if it's a parent message
      if (this.includeThreads && message.thread_ts === message.ts && message.reply_count) {
        const replies = await this.client!.conversations.replies({
          channel: channelId,
          ts: message.ts!,
        });

        if (replies.messages && replies.messages.length > 1) {
          // Build thread content
          const threadChunks = await this.threadToChunk(replies.messages, channelId);
          chunks.push(...threadChunks);
        }
      }

      return chunks;
    } catch (error) {
      this.log('error', `Failed to fetch message ${externalId}`, error);
      return [];
    }
  }

  async *listItems(cursor?: string): AsyncGenerator<ContentChunk[], void, undefined> {
    this.ensureInitialized();

    const oldestTs = Math.floor(Date.now() / 1000) - this.maxAgeDays * 24 * 60 * 60;

    for (const [channelId, channelName] of this.channelMap) {
      let nextCursor = cursor;

      while (true) {
        try {
          const result = await this.client!.conversations.history({
            channel: channelId,
            cursor: nextCursor,
            limit: 100,
            oldest: oldestTs.toString(),
          });

          if (!result.messages || result.messages.length === 0) {
            break;
          }

          const chunks: ContentChunk[] = [];

          for (const message of result.messages) {
            // Filter by importance
            if (!this.shouldIndex(message)) {
              continue;
            }

            const msgChunks = await this.messageToChunks(message, channelId);
            chunks.push(...msgChunks);

            // Include thread if applicable
            if (
              this.includeThreads &&
              message.thread_ts === message.ts &&
              message.reply_count &&
              message.reply_count > 0
            ) {
              try {
                const replies = await this.client!.conversations.replies({
                  channel: channelId,
                  ts: message.ts!,
                });

                if (replies.messages && replies.messages.length > 1) {
                  const threadChunks = await this.threadToChunk(replies.messages, channelId);
                  chunks.push(...threadChunks);
                }
              } catch (error) {
                this.log('warn', `Failed to fetch thread ${message.ts}`, error);
              }
            }
          }

          if (chunks.length > 0) {
            yield chunks;
          }

          if (!result.has_more || !result.response_metadata?.next_cursor) {
            break;
          }

          nextCursor = result.response_metadata.next_cursor;

          // Rate limit: Slack has strict limits
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          this.log('error', `Failed to list messages for channel ${channelName}`, error);
          break;
        }
      }
    }
  }

  async *getChanges(since: Date): AsyncGenerator<IntegrationEvent[], void, undefined> {
    // Slack doesn't have a good "changes since" API
    // We rely on webhooks for real-time updates
    // For backfill, use listItems with date filter
    this.log('info', 'getChanges not implemented for Slack - use webhooks');
    return;
  }

  extractReferences(content: string): ExternalReference[] {
    const refs: ExternalReference[] = [];

    // Jira issue references
    const jiraPattern = /\b([A-Z]+-\d+)\b/g;
    let match;
    while ((match = jiraPattern.exec(content)) !== null) {
      refs.push({
        type: 'jira',
        identifier: match[1],
      });
    }

    // GitHub links
    const ghPattern = /github\.com\/([^\/]+\/[^\/]+)(?:\/(?:pull|issues)\/(\d+))?/g;
    while ((match = ghPattern.exec(content)) !== null) {
      refs.push({
        type: 'github',
        identifier: match[2] ? `${match[1]}#${match[2]}` : match[1],
      });
    }

    // Confluence links
    const confluencePattern = /confluence\.[^\/]+\/(?:pages|display)\/(\d+|[A-Z]+\/[^\s]+)/g;
    while ((match = confluencePattern.exec(content)) !== null) {
      refs.push({
        type: 'confluence',
        identifier: match[1],
      });
    }

    return refs;
  }

  async resolveReference(ref: ExternalReference): Promise<string | null> {
    // Slack references would need channel context
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadChannels(): Promise<void> {
    try {
      const result = await this.client!.conversations.list({
        types: 'public_channel,private_channel',
        limit: 1000,
      });

      for (const channel of result.channels || []) {
        if (!channel.id || !channel.name) continue;

        // Check include/exclude
        if (this.includeChannels.some((p) => this.matchPattern(channel.name!, p))) {
          if (!this.excludeChannels.some((p) => this.matchPattern(channel.name!, p))) {
            this.channelMap.set(channel.id, channel.name);
          }
        }
      }
    } catch (error) {
      this.log('error', 'Failed to load channels', error);
    }
  }

  private matchPattern(name: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const regex = pattern.replace(/\*/g, '.*');
      return new RegExp(`^${regex}$`).test(name);
    }
    return name === pattern;
  }

  private shouldIndex(message: any): boolean {
    // Always index pinned messages
    if (message.pinned_to?.length > 0) return true;

    // Check reaction count
    const reactionCount = message.reactions?.reduce((sum: number, r: any) => sum + r.count, 0) ?? 0;
    if (reactionCount >= this.minReactions && this.minReactions > 0) return true;

    // Check for threads with replies
    if (message.reply_count && message.reply_count > 2) return true;

    // Check for important keywords
    const text = (message.text || '').toLowerCase();
    if (IMPORTANT_KEYWORDS.some((kw) => text.includes(kw))) return true;

    // If minReactions is 0, index everything
    if (this.minReactions === 0) return true;

    return false;
  }

  private async messageToChunks(message: any, channelId: string): Promise<ContentChunk[]> {
    const channelName = this.channelMap.get(channelId) || channelId;

    // Get user info
    let authorName = 'Unknown';
    let authorEmail: string | undefined;

    try {
      const userInfo = await this.client!.users.info({ user: message.user });
      authorName = userInfo.user?.real_name || userInfo.user?.name || 'Unknown';
      authorEmail = userInfo.user?.profile?.email;
    } catch {
      // Ignore user lookup failures
    }

    const ts = message.ts!;
    const tsForUrl = ts.replace('.', '');
    const sourceUrl = `https://${this.workspace}.slack.com/archives/${channelId}/p${tsForUrl}`;

    const reactions = message.reactions?.map((r: any) => `${r.name} (${r.count})`).join(', ') || '';

    const content = [
      `**Channel:** #${channelName}`,
      `**From:** ${authorName}`,
      `**Time:** ${new Date(parseFloat(ts) * 1000).toISOString()}`,
      reactions ? `**Reactions:** ${reactions}` : '',
      message.reply_count ? `**Replies:** ${message.reply_count}` : '',
      '',
      message.text || '',
    ]
      .filter(Boolean)
      .join('\n');

    const contentHash = this.hashContent(content);

    return [
      {
        id: this.generateChunkId(`${channelId}:${ts}`, contentHash),
        externalId: `${channelId}:${ts}`,
        sourceType: 'slack',
        sourceUrl,
        title: `Message in #${channelName}`,
        content,
        contentType: 'text',
        contentHash,
        chunkType: 'message',
        projectKey: channelName,
        authorEmail,
        authorName,
        createdAt: new Date(parseFloat(ts) * 1000),
        updatedAt: new Date(parseFloat(ts) * 1000),
        metadata: {
          channelId,
          channelName,
          ts,
          threadTs: message.thread_ts,
          reactions: message.reactions?.map((r: any) => ({ name: r.name, count: r.count })),
          replyCount: message.reply_count,
          isPinned: message.pinned_to?.length > 0,
        },
      },
    ];
  }

  private async threadToChunk(messages: any[], channelId: string): Promise<ContentChunk[]> {
    const channelName = this.channelMap.get(channelId) || channelId;
    const parentTs = messages[0]?.ts;

    if (!parentTs) return [];

    // Build thread content
    const threadContent: string[] = [`# Thread in #${channelName}`, ''];

    for (const msg of messages) {
      let authorName = 'Unknown';
      try {
        const userInfo = await this.client!.users.info({ user: msg.user });
        authorName = userInfo.user?.real_name || userInfo.user?.name || 'Unknown';
      } catch {
        // Ignore
      }

      const time = new Date(parseFloat(msg.ts) * 1000).toISOString();
      threadContent.push(`**${authorName}** (${time}):`);
      threadContent.push(msg.text || '');
      threadContent.push('');
    }

    const content = threadContent.join('\n');
    const contentHash = this.hashContent(content);
    const tsForUrl = parentTs.replace('.', '');

    return [
      {
        id: this.generateChunkId(`${channelId}:${parentTs}:thread`, contentHash),
        externalId: `${channelId}:${parentTs}:thread`,
        sourceType: 'slack',
        sourceUrl: `https://${this.workspace}.slack.com/archives/${channelId}/p${tsForUrl}`,
        title: `Thread in #${channelName} (${messages.length} messages)`,
        content,
        contentType: 'text',
        contentHash,
        chunkType: 'thread',
        parentId: this.generateChunkId(`${channelId}:${parentTs}`, ''),
        projectKey: channelName,
        createdAt: new Date(parseFloat(parentTs) * 1000),
        updatedAt: new Date(parseFloat(messages[messages.length - 1]?.ts || parentTs) * 1000),
        metadata: {
          channelId,
          channelName,
          parentTs,
          messageCount: messages.length,
        },
      },
    ];
  }
}
