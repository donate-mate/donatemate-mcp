/**
 * Knowledge Base Tools
 *
 * MCP tools for searching and retrieving organizational knowledge from
 * GitHub, Jira, Confluence, and Slack integrations.
 *
 * NOTE: These tools provide READ-ONLY access to the unified knowledge base.
 * For WRITE access (creating/updating issues, pages, messages, PRs), integrate
 * the respective official MCP servers:
 *
 * - GitHub: https://github.com/modelcontextprotocol/servers/tree/main/src/github
 * - Atlassian (Jira/Confluence): https://github.com/modelcontextprotocol/servers/tree/main/src/atlassian
 * - Slack: https://github.com/modelcontextprotocol/servers/tree/main/src/slack
 *
 * This MCP focuses on unified semantic search across all sources - something
 * the individual service MCPs cannot provide.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const TOOL_PREFIX = 'dm_knowledge';

// Cache the search function ARN
let searchFunctionArn: string = '';

const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});

async function getSearchFunctionArn(): Promise<string> {
  if (searchFunctionArn) return searchFunctionArn;

  const environment = process.env.ENVIRONMENT || 'staging';
  const paramName = `/donatemate/${environment}/knowledge/search-function-arn`;

  try {
    const response = await ssmClient.send(
      new GetParameterCommand({ Name: paramName })
    );
    searchFunctionArn = response.Parameter?.Value || '';
  } catch (error) {
    console.warn('[knowledge] Failed to get search function ARN:', error);
    searchFunctionArn = '';
  }

  return searchFunctionArn;
}

export const knowledgeTools: Tool[] = [
  {
    name: `${TOOL_PREFIX}_search`,
    description: `Search the DonateMate organizational knowledge base (READ-ONLY). This includes:
- **Code**: GitHub repositories (donatemate-app, donatemate-lambdas)
- **Issues**: Jira tickets, bugs, and feature requests
- **Documentation**: Confluence pages and wikis
- **Discussions**: Important Slack messages and threads

Use this to find relevant context about DonateMate's codebase, architecture, decisions, and processes.

**Note**: This tool provides read-only semantic search. For write operations (creating issues, updating pages, posting messages), use the respective MCP servers: GitHub MCP, Atlassian MCP, or Slack MCP.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query (e.g., "how does authentication work", "donation processing flow")',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['github', 'jira', 'confluence', 'slack'] },
          description: 'Optional: filter to specific sources (default: search all)',
        },
        project: {
          type: 'string',
          description: 'Optional: filter to a specific project/repo (e.g., "donatemate-app")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: `${TOOL_PREFIX}_context`,
    description: `Get comprehensive context about a DonateMate topic. Returns a curated set of related information from all knowledge sources. Best for understanding how different pieces of the system connect.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'The topic to get context about (e.g., "user authentication", "payment processing")',
        },
        depth: {
          type: 'string',
          enum: ['brief', 'detailed', 'comprehensive'],
          description: 'How much context to retrieve (default: detailed)',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: `${TOOL_PREFIX}_stats`,
    description: `Get statistics about the knowledge base, including total indexed content and breakdown by source.

This knowledge base provides unified read-only search across GitHub, Jira, Confluence, and Slack. For write access, integrate the respective MCP servers (GitHub MCP, Atlassian MCP, Slack MCP).`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: `${TOOL_PREFIX}_related`,
    description: `Find content related to a specific item (e.g., find Jira issues related to a code file, or Confluence docs about a feature).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        externalId: {
          type: 'string',
          description: 'The external ID of the item (e.g., "DM-123" for Jira, "owner/repo:file.ts" for GitHub)',
        },
        sourceType: {
          type: 'string',
          enum: ['github', 'jira', 'confluence', 'slack'],
          description: 'The source type of the item',
        },
      },
      required: ['externalId', 'sourceType'],
    },
  },
];

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface SearchRequest {
  query: string;
  filters?: {
    sourceTypes?: string[];
    projectKeys?: string[];
    chunkTypes?: string[];
  };
  limit?: number;
  includeContent?: boolean;
}

interface SearchResult {
  id: string;
  externalId: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  contentSnippet: string;
  chunkType: string;
  projectKey?: string;
  authorName?: string;
  score: number;
}

async function invokeSearch(request: SearchRequest): Promise<{ results: SearchResult[]; total: number }> {
  const functionArn = await getSearchFunctionArn();

  // If no function ARN configured, return empty results
  if (!functionArn) {
    console.warn('Knowledge search function ARN not configured');
    return { results: [], total: 0 };
  }

  const payload = {
    httpMethod: 'POST',
    path: '/search',
    body: JSON.stringify(request),
  };

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionArn,
      Payload: JSON.stringify(payload),
    })
  );

  const responsePayload = JSON.parse(new TextDecoder().decode(response.Payload));
  const body = JSON.parse(responsePayload.body || '{}');

  return {
    results: body.results || [],
    total: body.total || 0,
  };
}

async function invokeStats(): Promise<Record<string, unknown>> {
  const functionArn = await getSearchFunctionArn();

  if (!functionArn) {
    return { error: 'Knowledge base not configured' };
  }

  const payload = {
    httpMethod: 'GET',
    path: '/stats',
  };

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionArn,
      Payload: JSON.stringify(payload),
    })
  );

  const responsePayload = JSON.parse(new TextDecoder().decode(response.Payload));
  return JSON.parse(responsePayload.body || '{}');
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const formatted = results.map((r, i) => {
    const sourceIcon = {
      github: '📁',
      jira: '🎫',
      confluence: '📄',
      slack: '💬',
    }[r.sourceType] || '📌';

    return [
      `### ${i + 1}. ${sourceIcon} ${r.title}`,
      `**Source:** ${r.sourceType} | **Project:** ${r.projectKey || 'N/A'} | **Score:** ${(r.score * 100).toFixed(1)}%`,
      `**URL:** ${r.sourceUrl}`,
      '',
      r.contentSnippet,
      '',
      '---',
    ].join('\n');
  });

  return formatted.join('\n');
}

export async function handleKnowledgeTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  if (!name.startsWith(TOOL_PREFIX)) {
    return null;
  }

  try {
    switch (name) {
      case `${TOOL_PREFIX}_search`: {
        const { query, sources, project, limit = 10 } = args as {
          query: string;
          sources?: string[];
          project?: string;
          limit?: number;
        };

        const searchRequest: SearchRequest = {
          query,
          filters: {
            sourceTypes: sources,
            projectKeys: project ? [project] : undefined,
          },
          limit: Math.min(limit, 50),
          includeContent: false,
        };

        const { results, total } = await invokeSearch(searchRequest);

        return {
          content: [
            {
              type: 'text',
              text: [
                `## Knowledge Search Results`,
                `**Query:** "${query}"`,
                `**Found:** ${total} results`,
                sources ? `**Sources:** ${sources.join(', ')}` : '',
                '',
                formatSearchResults(results),
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_context`: {
        const { topic, depth = 'detailed' } = args as {
          topic: string;
          depth?: 'brief' | 'detailed' | 'comprehensive';
        };

        const limitMap = { brief: 5, detailed: 15, comprehensive: 30 };
        const limit = limitMap[depth];

        // Search across all sources for comprehensive context
        const { results } = await invokeSearch({
          query: topic,
          limit,
          includeContent: true,
        });

        // Group results by source
        const bySource: Record<string, SearchResult[]> = {};
        for (const r of results) {
          if (!bySource[r.sourceType]) {
            bySource[r.sourceType] = [];
          }
          bySource[r.sourceType].push(r);
        }

        const sections: string[] = [
          `## Context: ${topic}`,
          `**Depth:** ${depth}`,
          '',
        ];

        for (const [source, items] of Object.entries(bySource)) {
          const sourceIcon = {
            github: '📁 Code',
            jira: '🎫 Issues',
            confluence: '📄 Documentation',
            slack: '💬 Discussions',
          }[source] || source;

          sections.push(`### ${sourceIcon}`);
          sections.push('');

          for (const item of items.slice(0, 5)) {
            sections.push(`**${item.title}**`);
            sections.push(`> ${item.contentSnippet.slice(0, 200)}...`);
            sections.push(`[View](${item.sourceUrl})`);
            sections.push('');
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: sections.join('\n'),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_stats`: {
        const stats = await invokeStats();

        return {
          content: [
            {
              type: 'text',
              text: [
                '## Knowledge Base Statistics',
                '',
                `**Total indexed items:** ${stats.total || 0}`,
                '',
                '### By Source:',
                ...Object.entries(stats.bySource || {}).map(
                  ([source, data]: [string, any]) =>
                    `- **${source}:** ${data.count} items (last updated: ${data.lastUpdated || 'N/A'})`
                ),
              ].join('\n'),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_related`: {
        const { externalId, sourceType } = args as {
          externalId: string;
          sourceType: string;
        };

        // Search for related content using the external ID as query
        const { results } = await invokeSearch({
          query: externalId,
          filters: {
            // Exclude the source type to find cross-references
            sourceTypes: ['github', 'jira', 'confluence', 'slack'].filter(
              (s) => s !== sourceType
            ),
          },
          limit: 10,
        });

        return {
          content: [
            {
              type: 'text',
              text: [
                `## Related Content for ${externalId}`,
                `**Source:** ${sourceType}`,
                '',
                formatSearchResults(results),
              ].join('\n'),
            },
          ],
        };
      }

      default:
        return null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    };
  }
}
