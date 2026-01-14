/**
 * Confluence Integration Plugin
 * Indexes pages, blog posts, and spaces
 */

import { ConfluenceClient } from 'confluence.js';
// @ts-ignore - html-to-text doesn't have type definitions
import { convert } from 'html-to-text';
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
  spaces: z.array(z.string()),
  excludeLabels: z.array(z.string()).optional(),
  secrets: z.object({
    email: z.string().email(),
    token: z.string(),
  }),
});

type ConfluenceConfig = z.infer<typeof configSchema>;

export class ConfluencePlugin extends BasePlugin {
  readonly id = 'confluence' as const;
  readonly name = 'Confluence';
  readonly version = '1.0.0';
  readonly configSchema = configSchema;

  private client: ConfluenceClient | null = null;
  private host: string = '';
  private spaces: string[] = [];
  private excludeLabels: string[] = [];

  protected async onInitialize(config: IntegrationConfig): Promise<void> {
    const parsed = configSchema.parse(config.config) as ConfluenceConfig;

    this.client = new ConfluenceClient({
      host: parsed.host,
      authentication: {
        basic: {
          email: parsed.secrets.email,
          apiToken: parsed.secrets.token,
        },
      },
    });

    this.host = parsed.host;
    this.spaces = parsed.spaces;
    this.excludeLabels = parsed.excludeLabels ?? [];

    this.log('info', `Initialized for spaces: ${this.spaces.join(', ')}`);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      this.ensureInitialized();
      const user = await this.client!.users.getCurrentUser();

      return {
        healthy: true,
        message: `Connected as ${user.displayName}`,
        lastCheck: new Date(),
        details: { user: user.displayName, accountId: user.accountId },
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
    // Confluence Cloud webhooks don't have built-in signature validation
    return true;
  }

  async parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]> {
    const payload =
      typeof request.body === 'string'
        ? JSON.parse(request.body)
        : request.body;

    const events: IntegrationEvent[] = [];
    const eventType = payload.eventType;

    if (eventType?.includes('page')) {
      const page = payload.page;

      let event: IntegrationEvent['eventType'] = 'updated';
      if (eventType === 'page_created') event = 'created';
      else if (eventType === 'page_removed' || eventType === 'page_trashed') event = 'deleted';

      events.push({
        eventType: event,
        externalId: page.id,
        sourceType: 'confluence',
        timestamp: new Date(),
        projectKey: page.spaceKey,
        payload: {
          title: page.title,
          version: page.version?.number,
        },
      });
    } else if (eventType?.includes('blogpost')) {
      const blog = payload.blogPost;

      let event: IntegrationEvent['eventType'] = 'updated';
      if (eventType === 'blogpost_created') event = 'created';
      else if (eventType === 'blogpost_removed') event = 'deleted';

      events.push({
        eventType: event,
        externalId: blog.id,
        sourceType: 'confluence',
        timestamp: new Date(),
        projectKey: blog.spaceKey,
        payload: {
          title: blog.title,
          type: 'blogpost',
        },
      });
    }

    return events;
  }

  async fetchItem(externalId: string): Promise<ContentChunk[]> {
    this.ensureInitialized();

    try {
      const page = await this.client!.content.getContentById({
        id: externalId,
        expand: ['body.storage', 'space', 'ancestors', 'metadata.labels', 'version', 'history'],
      });

      return this.pageToChunks(page);
    } catch (error) {
      this.log('error', `Failed to fetch page ${externalId}`, error);
      return [];
    }
  }

  async *listItems(cursor?: string): AsyncGenerator<ContentChunk[], void, undefined> {
    this.ensureInitialized();

    for (const spaceKey of this.spaces) {
      let start = cursor ? parseInt(cursor, 10) : 0;
      const limit = 25;

      while (true) {
        try {
          const result = await this.client!.content.getContent({
            spaceKey,
            type: 'page' as any,
            status: 'current' as any,
            expand: ['body.storage', 'space', 'ancestors', 'metadata.labels', 'version', 'history'],
            start,
            limit,
          }) as unknown as { results?: any[]; size?: number };

          if (!result.results || result.results.length === 0) {
            break;
          }

          const chunks: ContentChunk[] = [];

          for (const page of result.results) {
            // Skip pages with excluded labels
            const labels = page.metadata?.labels?.results?.map((l: any) => l.name) ?? [];
            if (labels.some((l: string) => this.excludeLabels.includes(l))) {
              continue;
            }

            chunks.push(...this.pageToChunks(page));
          }

          if (chunks.length > 0) {
            yield chunks;
          }

          start += result.results.length;
          if (!result.size || start >= result.size) {
            break;
          }
        } catch (error) {
          this.log('error', `Failed to list pages for space ${spaceKey}`, error);
          break;
        }
      }
    }
  }

  async *getChanges(since: Date): AsyncGenerator<IntegrationEvent[], void, undefined> {
    this.ensureInitialized();

    for (const spaceKey of this.spaces) {
      try {
        // Use CQL to find recently updated content
        const cql = `space = "${spaceKey}" AND lastModified >= "${since.toISOString().split('T')[0]}" ORDER BY lastModified DESC`;

        const result = await this.client!.content.searchContentByCQL({
          cql,
          limit: 100,
          expand: ['history'],
        });

        if (result.results && result.results.length > 0) {
          const events: IntegrationEvent[] = result.results.map((page: any) => ({
            eventType:
              new Date(page.history?.createdDate) > since ? 'created' : 'updated',
            externalId: page.id,
            sourceType: 'confluence' as const,
            timestamp: new Date(page.history?.lastUpdated?.when || Date.now()),
            projectKey: spaceKey,
            payload: {
              title: page.title,
              type: page.type,
            },
          }));

          yield events;
        }
      } catch (error) {
        this.log('error', `Failed to get changes for space ${spaceKey}`, error);
      }
    }
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

    // Slack links
    const slackPattern = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/g;
    while ((match = slackPattern.exec(content)) !== null) {
      refs.push({
        type: 'slack',
        identifier: `${match[1]}:${match[2]}`,
      });
    }

    // Other Confluence page links
    const pageIdPattern = /\/pages\/(\d+)/g;
    while ((match = pageIdPattern.exec(content)) !== null) {
      refs.push({
        type: 'confluence',
        identifier: match[1],
      });
    }

    return refs;
  }

  async resolveReference(ref: ExternalReference): Promise<string | null> {
    if (ref.type !== 'confluence') return null;

    try {
      await this.client!.content.getContentById({ id: ref.identifier });
      return `confluence:${ref.identifier}`;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pageToChunks(page: any): ContentChunk[] {
    const chunks: ContentChunk[] = [];

    // Convert HTML to plain text/markdown
    const htmlContent = page.body?.storage?.value || '';
    const textContent = convert(htmlContent, {
      wordwrap: false,
      selectors: [
        { selector: 'a', format: 'inline' },
        { selector: 'img', format: 'skip' },
        { selector: 'table', format: 'dataTable' },
      ],
    });

    // Build breadcrumb from ancestors
    const ancestors = page.ancestors?.map((a: any) => a.title) ?? [];
    const breadcrumb = [...ancestors, page.title].join(' > ');

    const labels = page.metadata?.labels?.results?.map((l: any) => l.name) ?? [];

    const content = [
      `# ${page.title}`,
      '',
      `**Space:** ${page.space?.name || page.space?.key}`,
      `**Path:** ${breadcrumb}`,
      labels.length > 0 ? `**Labels:** ${labels.join(', ')}` : '',
      `**Last Updated:** ${page.history?.lastUpdated?.when || 'Unknown'}`,
      page.history?.lastUpdated?.by?.displayName
        ? `**Updated By:** ${page.history.lastUpdated.by.displayName}`
        : '',
      '',
      '---',
      '',
      textContent,
    ]
      .filter(Boolean)
      .join('\n');

    const contentHash = this.hashContent(content);

    chunks.push({
      id: this.generateChunkId(page.id, contentHash),
      externalId: page.id,
      sourceType: 'confluence',
      sourceUrl: `${this.host}/wiki${page._links?.webui || `/pages/${page.id}`}`,
      title: page.title,
      content,
      contentType: 'markdown',
      contentHash,
      chunkType: 'page',
      projectKey: page.space?.key,
      authorEmail: page.history?.createdBy?.email,
      authorName: page.history?.createdBy?.displayName,
      createdAt: new Date(page.history?.createdDate || Date.now()),
      updatedAt: new Date(page.history?.lastUpdated?.when || Date.now()),
      metadata: {
        spaceKey: page.space?.key,
        spaceName: page.space?.name,
        pageType: page.type,
        labels,
        version: page.version?.number,
        ancestors: ancestors,
        breadcrumb,
      },
    });

    return chunks;
  }
}
