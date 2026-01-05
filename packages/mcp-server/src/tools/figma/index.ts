/**
 * Figma Tools
 *
 * MCP tools for interacting with Figma via REST API.
 * Provides read-only access to files, components, styles, and comments.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getFigmaClient } from '../../services/figma-client.js';

const TOOL_PREFIX = 'dm_figma';

export const figmaTools: Tool[] = [
  {
    name: `${TOOL_PREFIX}_get_file`,
    description:
      'Get Figma file structure and metadata. Returns document tree, components, and styles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description:
            'The Figma file key (from URL: figma.com/file/{fileKey}/...)',
        },
        depth: {
          type: 'number',
          description: 'How deep to traverse the document tree (default: 2)',
        },
      },
      required: ['fileKey'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_node`,
    description:
      'Get detailed information about specific nodes in a Figma file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of node IDs to retrieve',
        },
        depth: {
          type: 'number',
          description: 'How deep to traverse children (default: 2)',
        },
      },
      required: ['fileKey', 'nodeIds'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_components`,
    description: 'List all components in a Figma file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
      },
      required: ['fileKey'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_styles`,
    description: 'List all styles (colors, text, effects) in a Figma file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
      },
      required: ['fileKey'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_comments`,
    description: 'Get all comments on a Figma file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
      },
      required: ['fileKey'],
    },
  },
  {
    name: `${TOOL_PREFIX}_post_comment`,
    description: 'Add a comment to a Figma file. Optionally attach to a specific node.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
        message: {
          type: 'string',
          description: 'The comment message',
        },
        nodeId: {
          type: 'string',
          description: 'Optional node ID to attach comment to',
        },
        x: {
          type: 'number',
          description: 'X position offset on the node',
        },
        y: {
          type: 'number',
          description: 'Y position offset on the node',
        },
      },
      required: ['fileKey', 'message'],
    },
  },
  {
    name: `${TOOL_PREFIX}_export`,
    description:
      'Export nodes as images. Returns URLs to download the exported images.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileKey: {
          type: 'string',
          description: 'The Figma file key',
        },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of node IDs to export',
        },
        format: {
          type: 'string',
          enum: ['jpg', 'png', 'svg', 'pdf'],
          description: 'Export format (default: png)',
        },
        scale: {
          type: 'number',
          description: 'Scale factor (0.01 to 4, default: 2)',
        },
      },
      required: ['fileKey', 'nodeIds'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_team_projects`,
    description: 'List all projects in a Figma team.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        teamId: {
          type: 'string',
          description: 'The Figma team ID',
        },
      },
      required: ['teamId'],
    },
  },
  {
    name: `${TOOL_PREFIX}_get_project_files`,
    description: 'List all files in a Figma project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: {
          type: 'string',
          description: 'The Figma project ID',
        },
      },
      required: ['projectId'],
    },
  },
];

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export async function handleFigmaTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  if (!name.startsWith(TOOL_PREFIX)) {
    return null; // Not a Figma tool
  }

  try {
    const client = getFigmaClient();

    switch (name) {
      case `${TOOL_PREFIX}_get_file`: {
        const { fileKey, depth } = args as { fileKey: string; depth?: number };
        const file = await client.getFile(fileKey, { depth: depth ?? 2 });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  name: file.name,
                  lastModified: file.lastModified,
                  version: file.version,
                  componentsCount: Object.keys(file.components || {}).length,
                  stylesCount: Object.keys(file.styles || {}).length,
                  document: file.document,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_get_node`: {
        const { fileKey, nodeIds, depth } = args as {
          fileKey: string;
          nodeIds: string[];
          depth?: number;
        };
        const result = await client.getNodes(fileKey, nodeIds, { depth: depth ?? 2 });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case `${TOOL_PREFIX}_get_components`: {
        const { fileKey } = args as { fileKey: string };
        const result = await client.getComponents(fileKey);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: result.meta.components.length,
                  components: result.meta.components,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_get_styles`: {
        const { fileKey } = args as { fileKey: string };
        const result = await client.getStyles(fileKey);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: result.meta.styles.length,
                  styles: result.meta.styles,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_get_comments`: {
        const { fileKey } = args as { fileKey: string };
        const result = await client.getComments(fileKey);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: result.comments.length,
                  comments: result.comments,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case `${TOOL_PREFIX}_post_comment`: {
        const { fileKey, message, nodeId, x, y } = args as {
          fileKey: string;
          message: string;
          nodeId?: string;
          x?: number;
          y?: number;
        };
        const result = await client.postComment(fileKey, message, { nodeId, x, y });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case `${TOOL_PREFIX}_export`: {
        const { fileKey, nodeIds, format, scale } = args as {
          fileKey: string;
          nodeIds: string[];
          format?: 'jpg' | 'png' | 'svg' | 'pdf';
          scale?: number;
        };
        const result = await client.getImages(fileKey, nodeIds, {
          format: format ?? 'png',
          scale,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case `${TOOL_PREFIX}_get_team_projects`: {
        const { teamId } = args as { teamId: string };
        const result = await client.getTeamProjects(teamId);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case `${TOOL_PREFIX}_get_project_files`: {
        const { projectId } = args as { projectId: string };
        const result = await client.getProjectFiles(projectId);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        return null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}
