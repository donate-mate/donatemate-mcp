/**
 * Design Token Tools
 *
 * MCP tools for querying and exporting DonateMate design tokens.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  loadTokens,
  flattenTokens,
  getToken,
  searchTokens,
  listCategories,
  exportTokens,
  resolveTokenValue,
} from '../../services/token-service.js';

const TOOL_PREFIX = 'dm_tokens';

export const tokenTools: Tool[] = [
  {
    name: `${TOOL_PREFIX}_list`,
    description:
      'List all DonateMate design tokens. Optionally filter by category (e.g., "global.colors", "light.text").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description:
            'Optional category to filter by (e.g., "global.colors", "light.background")',
        },
      },
    },
  },
  {
    name: `${TOOL_PREFIX}_get`,
    description:
      'Get a specific design token by its path (e.g., "light.text.primary", "global.colors.sky.500").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'The token path (e.g., "light.text.primary")',
        },
        resolve: {
          type: 'boolean',
          description: 'Whether to resolve token references to final values (default: true)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: `${TOOL_PREFIX}_search`,
    description:
      'Search design tokens by name, value, or description. Returns matching tokens.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (matches token paths, values, and descriptions)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: `${TOOL_PREFIX}_categories`,
    description: 'List all available token categories (top-level groups).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: `${TOOL_PREFIX}_export`,
    description:
      'Export design tokens in a specific format (CSS custom properties, JSON, or Tailwind config).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        format: {
          type: 'string',
          enum: ['css', 'json', 'tailwind'],
          description: 'Export format',
        },
        category: {
          type: 'string',
          description: 'Optional category to export (exports all if not specified)',
        },
      },
      required: ['format'],
    },
  },
];

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export async function handleTokenTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  if (!name.startsWith(TOOL_PREFIX)) {
    return null; // Not a token tool
  }

  try {
    switch (name) {
      case `${TOOL_PREFIX}_list`: {
        const category = (args as { category?: string })?.category;
        const tokens = loadTokens();
        const flatTokens = flattenTokens(tokens, '', category);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: flatTokens.length,
                  category: category || 'all',
                  tokens: flatTokens,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_get`: {
        const { path, resolve = true } = args as { path: string; resolve?: boolean };
        const token = getToken(path);

        if (!token) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Token not found: ${path}` }),
              },
            ],
            isError: true,
          };
        }

        const result = {
          ...token,
          resolvedValue: resolve ? resolveTokenValue(token.value) : undefined,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_search`: {
        const { query } = args as { query: string };
        const results = searchTokens(query);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  count: results.length,
                  tokens: results,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_categories`: {
        const categories = listCategories();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ categories }, null, 2),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_export`: {
        const { format, category } = args as {
          format: 'css' | 'json' | 'tailwind';
          category?: string;
        };
        const exported = exportTokens(format, category);

        return {
          content: [
            {
              type: 'text',
              text: exported,
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
