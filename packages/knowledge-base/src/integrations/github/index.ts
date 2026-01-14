/**
 * GitHub Integration Plugin
 * Indexes code repositories with AST-aware chunking
 */

import { Octokit } from '@octokit/rest';
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
  ChunkType,
} from '../../types/index.js';

// Configuration schema
const configSchema = z.object({
  repos: z.array(
    z.object({
      owner: z.string(),
      name: z.string(),
      branches: z.array(z.string()).optional().default(['main']),
    })
  ),
  secrets: z.object({
    token: z.string(), // GitHub PAT or ARN to secrets manager
    webhookSecret: z.string().optional(),
  }),
  filePatterns: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
});

type GitHubConfig = z.infer<typeof configSchema>;

// File extension to language mapping
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.prisma': 'prisma',
};

// Default file patterns
const DEFAULT_INCLUDE = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.py',
  '**/*.go',
  '**/*.prisma',
  '**/*.yaml',
  '**/*.yml',
  '**/openapi.yaml',
  '**/schema.prisma',
];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

export class GitHubPlugin extends BasePlugin {
  readonly id = 'github' as const;
  readonly name = 'GitHub';
  readonly version = '1.0.0';
  readonly configSchema = configSchema;

  private octokit: Octokit | null = null;
  private webhookSecret: string | null = null;
  private repos: GitHubConfig['repos'] = [];
  private filePatterns: GitHubConfig['filePatterns'];

  protected async onInitialize(config: IntegrationConfig): Promise<void> {
    const parsed = configSchema.parse(config.config) as GitHubConfig;

    this.octokit = new Octokit({
      auth: parsed.secrets.token,
    });

    this.webhookSecret = parsed.secrets.webhookSecret ?? null;
    this.repos = parsed.repos;
    this.filePatterns = parsed.filePatterns;

    this.log('info', `Initialized with ${this.repos.length} repositories`);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      this.ensureInitialized();
      const { data } = await this.octokit!.users.getAuthenticated();

      return {
        healthy: true,
        message: `Authenticated as ${data.login}`,
        lastCheck: new Date(),
        details: { user: data.login, rateLimit: data },
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
    if (!this.webhookSecret) {
      // No secret configured, skip validation
      return true;
    }

    const signature = request.headers['x-hub-signature-256'];
    if (!signature) return false;

    const body =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    const expected =
      'sha256=' +
      createHmac('sha256', this.webhookSecret).update(body).digest('hex');

    return signature === expected;
  }

  async parseWebhook(request: WebhookRequest): Promise<IntegrationEvent[]> {
    const event = request.headers['x-github-event'];
    const payload =
      typeof request.body === 'string'
        ? JSON.parse(request.body)
        : request.body;

    const events: IntegrationEvent[] = [];

    if (event === 'push') {
      // Handle push event - files changed
      const { repository, ref, commits, before, after } = payload;
      const branch = ref.replace('refs/heads/', '');

      // Aggregate all changed files
      const added = new Set<string>();
      const modified = new Set<string>();
      const removed = new Set<string>();

      for (const commit of commits || []) {
        commit.added?.forEach((f: string) => added.add(f));
        commit.modified?.forEach((f: string) => modified.add(f));
        commit.removed?.forEach((f: string) => removed.add(f));
      }

      // Create events for each file
      for (const file of added) {
        events.push({
          eventType: 'created',
          externalId: `${repository.full_name}/${branch}/${file}`,
          sourceType: 'github',
          timestamp: new Date(),
          projectKey: repository.full_name,
          branch,
          payload: { file, commitSha: after },
        });
      }

      for (const file of modified) {
        events.push({
          eventType: 'updated',
          externalId: `${repository.full_name}/${branch}/${file}`,
          sourceType: 'github',
          timestamp: new Date(),
          projectKey: repository.full_name,
          branch,
          payload: { file, commitSha: after },
        });
      }

      for (const file of removed) {
        events.push({
          eventType: 'deleted',
          externalId: `${repository.full_name}/${branch}/${file}`,
          sourceType: 'github',
          timestamp: new Date(),
          projectKey: repository.full_name,
          branch,
          payload: { file },
        });
      }
    } else if (event === 'create' || event === 'delete') {
      // Branch created/deleted
      const { repository, ref, ref_type } = payload;

      if (ref_type === 'branch') {
        events.push({
          eventType: event === 'create' ? 'created' : 'deleted',
          externalId: `${repository.full_name}/${ref}`,
          sourceType: 'github',
          timestamp: new Date(),
          projectKey: repository.full_name,
          branch: ref,
          payload: { refType: ref_type },
        });
      }
    }

    return events;
  }

  async fetchItem(
    externalId: string,
    options?: { branch?: string }
  ): Promise<ContentChunk[]> {
    this.ensureInitialized();

    // Parse externalId: owner/repo/branch/path or owner/repo/path
    const parts = externalId.split('/');
    const owner = parts[0];
    const repo = parts[1];
    let branch = options?.branch || 'main';
    let filePath: string;

    // Determine if branch is in the ID
    if (parts.length > 3 && this.repos.some((r) => r.owner === owner && r.name === repo)) {
      branch = parts[2];
      filePath = parts.slice(3).join('/');
    } else {
      filePath = parts.slice(2).join('/');
    }

    try {
      const { data } = await this.octokit!.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch,
      });

      if (Array.isArray(data)) {
        // Directory - should not happen for fetchItem
        return [];
      }

      if (data.type !== 'file' || !('content' in data)) {
        return [];
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return this.chunkFile(content, filePath, owner, repo, branch, data.sha);
    } catch (error) {
      this.log('error', `Failed to fetch ${externalId}`, error);
      return [];
    }
  }

  async *listItems(cursor?: string): AsyncGenerator<ContentChunk[], void, undefined> {
    this.ensureInitialized();

    for (const repoConfig of this.repos) {
      for (const branch of repoConfig.branches || ['main']) {
        // Handle glob patterns in branch names
        const branches = await this.resolveBranches(
          repoConfig.owner,
          repoConfig.name,
          branch
        );

        for (const resolvedBranch of branches) {
          yield* this.listRepoFiles(
            repoConfig.owner,
            repoConfig.name,
            resolvedBranch
          );
        }
      }
    }
  }

  async *getChanges(
    since: Date
  ): AsyncGenerator<IntegrationEvent[], void, undefined> {
    this.ensureInitialized();

    for (const repoConfig of this.repos) {
      for (const branch of repoConfig.branches || ['main']) {
        const branches = await this.resolveBranches(
          repoConfig.owner,
          repoConfig.name,
          branch
        );

        for (const resolvedBranch of branches) {
          try {
            const { data: commits } = await this.octokit!.repos.listCommits({
              owner: repoConfig.owner,
              repo: repoConfig.name,
              sha: resolvedBranch,
              since: since.toISOString(),
              per_page: 100,
            });

            for (const commit of commits) {
              const { data: details } = await this.octokit!.repos.getCommit({
                owner: repoConfig.owner,
                repo: repoConfig.name,
                ref: commit.sha,
              });

              const events: IntegrationEvent[] = [];

              for (const file of details.files || []) {
                const eventType =
                  file.status === 'added'
                    ? 'created'
                    : file.status === 'removed'
                    ? 'deleted'
                    : 'updated';

                events.push({
                  eventType,
                  externalId: `${repoConfig.owner}/${repoConfig.name}/${resolvedBranch}/${file.filename}`,
                  sourceType: 'github',
                  timestamp: new Date(commit.commit.author?.date || Date.now()),
                  projectKey: `${repoConfig.owner}/${repoConfig.name}`,
                  branch: resolvedBranch,
                  payload: {
                    file: file.filename,
                    commitSha: commit.sha,
                    status: file.status,
                  },
                });
              }

              if (events.length > 0) {
                yield events;
              }
            }
          } catch (error) {
            this.log('error', `Failed to get changes for ${repoConfig.owner}/${repoConfig.name}`, error);
          }
        }
      }
    }
  }

  extractReferences(content: string): ExternalReference[] {
    const refs: ExternalReference[] = [];

    // Jira issue references (e.g., DM-123)
    const jiraPattern = /\b([A-Z]+-\d+)\b/g;
    let match;
    while ((match = jiraPattern.exec(content)) !== null) {
      refs.push({
        type: 'jira',
        identifier: match[1],
        context: content.substring(
          Math.max(0, match.index - 20),
          Math.min(content.length, match.index + match[0].length + 20)
        ),
      });
    }

    // GitHub issue/PR references (e.g., #123)
    const ghIssuePattern = /#(\d+)/g;
    while ((match = ghIssuePattern.exec(content)) !== null) {
      refs.push({
        type: 'github',
        identifier: match[1],
        context: content.substring(
          Math.max(0, match.index - 20),
          Math.min(content.length, match.index + match[0].length + 20)
        ),
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
    if (ref.type !== 'github') return null;

    // For GitHub, the identifier is the issue/PR number
    // Would need repo context to fully resolve
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async *listRepoFiles(
    owner: string,
    repo: string,
    branch: string
  ): AsyncGenerator<ContentChunk[], void, undefined> {
    try {
      // Get tree recursively
      const { data: tree } = await this.octokit!.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: 'true',
      });

      // Filter files by patterns
      const files = tree.tree.filter((item) => {
        if (item.type !== 'blob') return false;
        if (!item.path) return false;

        const path = item.path;
        const include = this.filePatterns?.include || DEFAULT_INCLUDE;
        const exclude = this.filePatterns?.exclude || DEFAULT_EXCLUDE;

        // Check exclude patterns
        for (const pattern of exclude) {
          if (this.matchPattern(path, pattern)) return false;
        }

        // Check include patterns
        for (const pattern of include) {
          if (this.matchPattern(path, pattern)) return true;
        }

        return false;
      });

      // Process files in batches
      const batchSize = 10;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const chunks: ContentChunk[] = [];

        await Promise.all(
          batch.map(async (file) => {
            try {
              const { data } = await this.octokit!.repos.getContent({
                owner,
                repo,
                path: file.path!,
                ref: branch,
              });

              if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
                const content = Buffer.from(data.content, 'base64').toString('utf-8');
                const fileChunks = this.chunkFile(
                  content,
                  file.path!,
                  owner,
                  repo,
                  branch,
                  data.sha
                );
                chunks.push(...fileChunks);
              }
            } catch (error) {
              this.log('warn', `Failed to fetch file ${file.path}`, error);
            }
          })
        );

        if (chunks.length > 0) {
          yield chunks;
        }
      }
    } catch (error) {
      this.log('error', `Failed to list files for ${owner}/${repo}@${branch}`, error);
    }
  }

  private async resolveBranches(
    owner: string,
    repo: string,
    pattern: string
  ): Promise<string[]> {
    if (!pattern.includes('*')) {
      return [pattern];
    }

    try {
      const { data: branches } = await this.octokit!.repos.listBranches({
        owner,
        repo,
        per_page: 100,
      });

      return branches
        .filter((b) => this.matchPattern(b.name, pattern))
        .map((b) => b.name);
    } catch (error) {
      this.log('warn', `Failed to resolve branch pattern ${pattern}`, error);
      return [];
    }
  }

  private matchPattern(path: string, pattern: string): boolean {
    // Simple glob matching
    const regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/{{GLOBSTAR}}/g, '.*');

    return new RegExp(`^${regex}$`).test(path);
  }

  private chunkFile(
    content: string,
    filePath: string,
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ): ContentChunk[] {
    const ext = '.' + filePath.split('.').pop()?.toLowerCase();
    const language = LANGUAGE_MAP[ext] || 'text';
    const projectKey = `${owner}/${repo}`;
    const baseUrl = `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;

    // For now, create a single chunk per file
    // TODO: Implement AST-based chunking with tree-sitter
    const chunks: ContentChunk[] = [];

    const contentHash = this.hashContent(content);
    const chunkId = this.generateChunkId(`${projectKey}/${branch}/${filePath}`, contentHash);

    // Determine chunk type based on content
    let chunkType: ChunkType = 'file';
    if (filePath.endsWith('.prisma')) chunkType = 'module';
    else if (filePath.includes('component')) chunkType = 'component';
    else if (filePath.includes('handler') || filePath.includes('controller')) chunkType = 'function';

    chunks.push({
      id: chunkId,
      externalId: `${projectKey}/${branch}/${filePath}`,
      sourceType: 'github',
      sourceUrl: baseUrl,
      title: filePath.split('/').pop() || filePath,
      content,
      contentType: 'code',
      contentHash,
      chunkType,
      projectKey,
      branch,
      filePath,
      language,
      symbols: this.extractSymbols(content, language),
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        sha,
        size: content.length,
        lines: content.split('\n').length,
      },
    });

    return chunks;
  }

  private extractSymbols(content: string, language: string): string[] {
    const symbols: string[] = [];

    // Simple regex-based symbol extraction
    // TODO: Use tree-sitter for accurate AST-based extraction
    if (language === 'typescript' || language === 'javascript') {
      // Functions
      const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
      let match;
      while ((match = funcPattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }

      // Classes
      const classPattern = /(?:export\s+)?class\s+(\w+)/g;
      while ((match = classPattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }

      // Interfaces/Types
      const typePattern = /(?:export\s+)?(?:interface|type)\s+(\w+)/g;
      while ((match = typePattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }

      // Arrow functions assigned to const
      const arrowPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
      while ((match = arrowPattern.exec(content)) !== null) {
        symbols.push(match[1]);
      }
    }

    return [...new Set(symbols)];
  }
}
