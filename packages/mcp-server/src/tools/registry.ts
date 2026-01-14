/**
 * Tool Registry
 *
 * Central registry for all MCP tools. Combines tools from different modules
 * and provides a unified handler.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { tokenTools, handleTokenTool } from './tokens/index.js';
import { figmaTools, handleFigmaTool } from './figma/index.js';
import { knowledgeTools, handleKnowledgeTool } from './knowledge/index.js';

// Combine all tools
const allTools = [...tokenTools, ...figmaTools, ...knowledgeTools];

// Tool handlers in order of priority
const handlers = [handleTokenTool, handleFigmaTool, handleKnowledgeTool];

export function registerAllTools(server: Server): void {
  // Register list tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  // Register call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    // Try each handler until one returns a result
    for (const handler of handlers) {
      const result = await handler(name, (args as Record<string, unknown>) || {});
      if (result !== null) {
        return result as CallToolResult;
      }
    }

    // No handler found
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
      isError: true,
    };
  });
}
