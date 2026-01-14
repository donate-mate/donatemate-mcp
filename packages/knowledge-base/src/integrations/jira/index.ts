/**
 * Jira Integration Plugin
 * Indexes issues, epics, and comments
 */

import { Version3Client } from 'jira.js';
import { createHmac } from 'crypto';
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
  host: z.string().url(),
  projects: z.array(z.string()),
  issueTypes: z.array(z.string()).optional(),
  excludeStatuses: z.array(z.string()).optional(),
  secrets: z.object({
    email: z.string().email(),
    token: z.string(),
    webhookSecret: z.string().optional(),
  }),
});

type JiraConfig = z.infer<typeof configSchema>;

export class JiraPlugin extends BasePlugin {
  readonly id = 'jira' as const;
  readonly name = 'Jira';
  readonly version = '1.0.0';
  readonly configSchema = configSchema;

  private client: Version3Client | null = null;
  private host: string = '';
  private projects: string[] = [];
  private issueTypes: string[] | null = null;
  private excludeStatuses: string[] = [];
  private webhookSecret: string | null = null;

  protected async onInitialize(config: IntegrationConfig): Promise<void> {
    const parsed = configSchema.parse(config.config) as JiraConfig;

    this.client = new Version3Client({
      host: parsed.host,
      authentication: {
        basic: {
          email: parsed.secrets.email,
          apiToken: parsed.secrets.token,
        },
      },
    });

    this.host = parsed.host;
    this.projects = parsed.projects;
    this.issueTypes = parsed.issueTypes ?? null;
    this.excludeStatuses = parsed.excludeStatuses ?? [];
    this.webhookSecret = parsed.secrets.webhookSecret ?? null;

    this.log('info', `Initialized for projects: ${this.projects.join(', ')}`);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      this.ensureInitialized();
      const myself = await this.client!.myself.getCurrentUser();

      return {
        healthy: true,
        message: `Connected as ${myself.displayName}`,
        lastCheck: new Date(),
        details: { user: myself.displayName, accountId: myself.accountId },
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
    // Jira Cloud doesn't use signature validation by default
    // Could implement IP allowlist or custom header validation
    return true;
  }

  async parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]> {
    const payload =
      typeof request.body === 'string'
        ? JSON.parse(request.body)
        : request.body;

    const events: IntegrationEvent[] = [];
    const webhookEvent = payload.webhookEvent;

    if (webhookEvent?.startsWith('jira:issue_')) {
      const issue = payload.issue;
      const eventType =
        webhookEvent === 'jira:issue_created'
          ? 'created'
          : webhookEvent === 'jira:issue_deleted'
          ? 'deleted'
          : 'updated';

      events.push({
        eventType,
        externalId: issue.key,
        sourceType: 'jira',
        timestamp: new Date(),
        projectKey: issue.fields?.project?.key,
        payload: {
          issueType: issue.fields?.issuetype?.name,
          status: issue.fields?.status?.name,
          summary: issue.fields?.summary,
        },
      });
    } else if (webhookEvent === 'comment_created' || webhookEvent === 'comment_updated') {
      const issue = payload.issue;
      const comment = payload.comment;

      events.push({
        eventType: 'updated',
        externalId: issue.key,
        sourceType: 'jira',
        timestamp: new Date(),
        projectKey: issue.fields?.project?.key,
        payload: {
          commentId: comment.id,
          commentAction: webhookEvent === 'comment_created' ? 'added' : 'updated',
        },
      });
    }

    return events;
  }

  async fetchItem(externalId: string): Promise<ContentChunk[]> {
    this.ensureInitialized();

    try {
      const issue = await this.client!.issues.getIssue({
        issueIdOrKey: externalId,
        expand: 'renderedFields,names,changelog',
        fields: [
          'summary',
          'description',
          'issuetype',
          'status',
          'priority',
          'assignee',
          'reporter',
          'labels',
          'components',
          'parent',
          'subtasks',
          'comment',
          'created',
          'updated',
        ],
      });

      return this.issueToChunks(issue);
    } catch (error) {
      this.log('error', `Failed to fetch issue ${externalId}`, error);
      return [];
    }
  }

  async *listItems(cursor?: string): AsyncGenerator<ContentChunk[], void, undefined> {
    this.ensureInitialized();

    for (const project of this.projects) {
      let startAt = cursor ? parseInt(cursor, 10) : 0;
      const maxResults = 50;

      while (true) {
        try {
          // Build JQL
          let jql = `project = ${project}`;
          if (this.issueTypes && this.issueTypes.length > 0) {
            jql += ` AND issuetype IN (${this.issueTypes.map((t) => `"${t}"`).join(', ')})`;
          }
          if (this.excludeStatuses.length > 0) {
            jql += ` AND status NOT IN (${this.excludeStatuses.map((s) => `"${s}"`).join(', ')})`;
          }
          jql += ' ORDER BY updated DESC';

          const result = await this.client!.issueSearch.searchForIssuesUsingJql({
            jql,
            startAt,
            maxResults,
            fields: [
              'summary',
              'description',
              'issuetype',
              'status',
              'priority',
              'assignee',
              'reporter',
              'labels',
              'components',
              'parent',
              'comment',
              'created',
              'updated',
            ],
          });

          if (!result.issues || result.issues.length === 0) {
            break;
          }

          const chunks: ContentChunk[] = [];
          for (const issue of result.issues) {
            chunks.push(...this.issueToChunks(issue));
          }

          yield chunks;

          startAt += result.issues.length;
          if (startAt >= (result.total ?? 0)) {
            break;
          }
        } catch (error) {
          this.log('error', `Failed to list issues for project ${project}`, error);
          break;
        }
      }
    }
  }

  async *getChanges(since: Date): AsyncGenerator<IntegrationEvent[], void, undefined> {
    this.ensureInitialized();

    for (const project of this.projects) {
      const jql = `project = ${project} AND updated >= "${since.toISOString().split('T')[0]}" ORDER BY updated DESC`;

      try {
        const result = await this.client!.issueSearch.searchForIssuesUsingJql({
          jql,
          maxResults: 100,
          fields: ['key', 'updated', 'created'],
        });

        if (result.issues && result.issues.length > 0) {
          const events: IntegrationEvent[] = result.issues.map((issue) => ({
            eventType:
              new Date(issue.fields?.created as string) > since ? 'created' : 'updated',
            externalId: issue.key!,
            sourceType: 'jira' as const,
            timestamp: new Date(issue.fields?.updated as string),
            projectKey: project,
          }));

          yield events;
        }
      } catch (error) {
        this.log('error', `Failed to get changes for project ${project}`, error);
      }
    }
  }

  extractReferences(content: string): ExternalReference[] {
    const refs: ExternalReference[] = [];

    // GitHub references
    const ghPattern = /github\.com\/([^\/]+\/[^\/]+)\/(?:pull|issues)\/(\d+)/g;
    let match;
    while ((match = ghPattern.exec(content)) !== null) {
      refs.push({
        type: 'github',
        identifier: `${match[1]}#${match[2]}`,
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

    // Slack message links
    const slackPattern = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/g;
    while ((match = slackPattern.exec(content)) !== null) {
      refs.push({
        type: 'slack',
        identifier: `${match[1]}:${match[2]}`,
      });
    }

    return refs;
  }

  async resolveReference(ref: ExternalReference): Promise<string | null> {
    if (ref.type !== 'jira') return null;

    // Verify the issue exists
    try {
      await this.client!.issues.getIssue({ issueIdOrKey: ref.identifier });
      return `jira:${ref.identifier}`;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private issueToChunks(issue: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];

    // Extract description text from Atlassian Document Format
    const descriptionText = this.extractAdfText(issue.fields?.description);

    // Build content combining summary and description
    const content = [
      `# ${issue.key}: ${issue.fields?.summary || 'No summary'}`,
      '',
      `**Type:** ${issue.fields?.issuetype?.name || 'Unknown'}`,
      `**Status:** ${issue.fields?.status?.name || 'Unknown'}`,
      `**Priority:** ${issue.fields?.priority?.name || 'None'}`,
      issue.fields?.assignee ? `**Assignee:** ${issue.fields.assignee.displayName}` : '',
      issue.fields?.reporter ? `**Reporter:** ${issue.fields.reporter.displayName}` : '',
      issue.fields?.labels?.length > 0 ? `**Labels:** ${issue.fields.labels.join(', ')}` : '',
      issue.fields?.components?.length > 0
        ? `**Components:** ${issue.fields.components.map((c: any) => c.name).join(', ')}`
        : '',
      issue.fields?.parent ? `**Parent:** ${issue.fields.parent.key}` : '',
      '',
      '## Description',
      descriptionText || 'No description',
    ]
      .filter(Boolean)
      .join('\n');

    const contentHash = this.hashContent(content);

    chunks.push({
      id: this.generateChunkId(issue.key!, contentHash),
      externalId: issue.key!,
      sourceType: 'jira',
      sourceUrl: `${this.host}/browse/${issue.key}`,
      title: `${issue.key}: ${issue.fields?.summary || 'No summary'}`,
      content,
      contentType: 'markdown',
      contentHash,
      chunkType: 'issue',
      projectKey: issue.fields?.project?.key,
      authorEmail: issue.fields?.reporter?.emailAddress,
      authorName: issue.fields?.reporter?.displayName,
      createdAt: new Date(issue.fields?.created),
      updatedAt: new Date(issue.fields?.updated),
      metadata: {
        issueType: issue.fields?.issuetype?.name,
        status: issue.fields?.status?.name,
        priority: issue.fields?.priority?.name,
        labels: issue.fields?.labels,
        components: issue.fields?.components?.map((c: any) => c.name),
        parentKey: issue.fields?.parent?.key,
        subtaskCount: issue.fields?.subtasks?.length ?? 0,
        commentCount: issue.fields?.comment?.total ?? 0,
      },
    });

    // Add comments as separate chunks
    const comments = issue.fields?.comment?.comments || [];
    for (const comment of comments) {
      const commentText = this.extractAdfText(comment.body);
      if (!commentText) continue;

      const commentContent = `Comment by ${comment.author?.displayName}:\n\n${commentText}`;
      const commentHash = this.hashContent(commentContent);

      chunks.push({
        id: this.generateChunkId(`${issue.key}:comment:${comment.id}`, commentHash),
        externalId: `${issue.key}:comment:${comment.id}`,
        sourceType: 'jira',
        sourceUrl: `${this.host}/browse/${issue.key}?focusedCommentId=${comment.id}`,
        title: `Comment on ${issue.key}`,
        content: commentContent,
        contentType: 'markdown',
        contentHash: commentHash,
        chunkType: 'comment',
        parentId: this.generateChunkId(issue.key!, contentHash),
        projectKey: issue.fields?.project?.key,
        authorEmail: comment.author?.emailAddress,
        authorName: comment.author?.displayName,
        createdAt: new Date(comment.created),
        updatedAt: new Date(comment.updated),
        metadata: {
          commentId: comment.id,
          issueKey: issue.key,
        },
      });
    }

    return chunks;
  }

  private extractAdfText(adf: any): string {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;

    const extractFromNode = (node: any): string => {
      if (!node) return '';

      if (node.type === 'text') {
        return node.text || '';
      }

      if (node.content && Array.isArray(node.content)) {
        return node.content.map(extractFromNode).join('');
      }

      if (node.type === 'paragraph') {
        return extractFromNode({ content: node.content }) + '\n\n';
      }

      if (node.type === 'bulletList' || node.type === 'orderedList') {
        return (
          node.content
            ?.map((item: any, i: number) => {
              const prefix = node.type === 'orderedList' ? `${i + 1}. ` : '- ';
              return prefix + extractFromNode(item);
            })
            .join('\n') + '\n'
        );
      }

      if (node.type === 'codeBlock') {
        const lang = node.attrs?.language || '';
        const code = node.content?.map(extractFromNode).join('') || '';
        return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
      }

      if (node.type === 'heading') {
        const level = node.attrs?.level || 1;
        const text = node.content?.map(extractFromNode).join('') || '';
        return `${'#'.repeat(level)} ${text}\n\n`;
      }

      return '';
    };

    return extractFromNode(adf).trim();
  }
}
