/**
 * Stdio Adapter for MCP Server
 *
 * Enables communication with Claude Code via stdin/stdout.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '../server.js';

export async function startStdioAdapter(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error(`DonateMate MCP Server v${server.version} started (stdio mode)`);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('Shutting down...');
    await server.close();
    process.exit(0);
  });
}
