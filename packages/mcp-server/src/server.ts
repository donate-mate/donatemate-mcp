/**
 * DonateMate MCP Server Factory
 *
 * Creates and configures the MCP server with all tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerAllTools } from './tools/registry.js';

export interface McpServer extends Server {
  name: string;
  version: string;
}

export function createServer(): McpServer {
  const server = new Server(
    {
      name: 'donatemate-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  ) as McpServer;

  server.name = 'donatemate-mcp';
  server.version = '0.1.0';

  // Register all tools from the central registry
  registerAllTools(server);

  return server;
}
