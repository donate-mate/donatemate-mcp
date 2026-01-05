#!/usr/bin/env node
/**
 * DonateMate MCP Server Entry Point
 *
 * Supports two modes:
 * - stdio: For local Claude Code integration
 * - websocket: For remote Claude.ai integration (future)
 */

import { createServer } from './server.js';
import { startStdioAdapter } from './adapters/stdio.js';

const mode = process.env.MCP_MODE || 'stdio';

async function main(): Promise<void> {
  const server = createServer();

  switch (mode) {
    case 'stdio':
      await startStdioAdapter(server);
      break;
    case 'websocket':
      // Future: WebSocket adapter for remote connections
      console.error('WebSocket mode not yet implemented');
      process.exit(1);
      break;
    default:
      console.error(`Unknown mode: ${mode}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
