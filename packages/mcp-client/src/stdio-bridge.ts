#!/usr/bin/env node
/**
 * MCP stdio-to-WebSocket Bridge
 *
 * This adapter allows Claude Desktop, Claude Code, and other MCP clients
 * to connect to our remote WebSocket-based MCP server via stdio transport.
 *
 * Usage:
 *   node stdio-bridge.js [--url <websocket-url>]
 *
 * The bridge reads JSON-RPC messages from stdin, forwards them to the WebSocket
 * server, and writes responses to stdout.
 */

import WebSocket from 'ws';
import * as readline from 'readline';

// Configuration
const DEFAULT_WS_URL = 'wss://hnho35cprc.execute-api.us-east-2.amazonaws.com/staging';

// Parse command line arguments
function parseArgs(): { wsUrl: string } {
  const args = process.argv.slice(2);
  let wsUrl = DEFAULT_WS_URL;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      wsUrl = args[i + 1];
      i++;
    }
  }

  return { wsUrl };
}

// Logging to stderr (stdout is reserved for MCP protocol)
function log(message: string, ...args: unknown[]): void {
  console.error(`[MCP Bridge] ${message}`, ...args);
}

class StdioBridge {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private pendingRequests = new Map<string | number, (response: unknown) => void>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnected = false;
  private messageQueue: string[] = [];

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async start(): Promise<void> {
    // Connect to WebSocket server
    await this.connect();

    // Set up stdin reader for JSON-RPC messages
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      this.handleStdinMessage(line);
    });

    rl.on('close', () => {
      log('stdin closed, shutting down');
      this.cleanup();
      process.exit(0);
    });

    // Handle process signals
    process.on('SIGINT', () => {
      log('Received SIGINT, shutting down');
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      log('Received SIGTERM, shutting down');
      this.cleanup();
      process.exit(0);
    });
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      log(`Connecting to ${this.wsUrl}...`);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        log('Connected to WebSocket server');
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Send any queued messages
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift()!;
          this.ws?.send(msg);
        }

        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleWsMessage(data.toString());
      });

      this.ws.on('close', () => {
        log('WebSocket connection closed');
        this.isConnected = false;
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        log('WebSocket error:', error.message);
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log('Max reconnect attempts reached, exiting');
      process.exit(1);
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        log('Reconnect failed:', error);
      }
    }, delay);
  }

  private handleStdinMessage(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);
      log('Received from stdin:', message.method || message.id);

      // Forward to WebSocket
      if (this.isConnected && this.ws) {
        this.ws.send(line);
      } else {
        // Queue message for when connection is restored
        this.messageQueue.push(line);
        log('Connection not ready, queued message');
      }
    } catch (error) {
      log('Failed to parse stdin message:', error);
    }
  }

  private handleWsMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      log('Received from WebSocket:', message.id ? `response ${message.id}` : 'notification');

      // Write to stdout for MCP client
      process.stdout.write(data + '\n');
    } catch (error) {
      log('Failed to parse WebSocket message:', error);
    }
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Main entry point
async function main(): Promise<void> {
  const { wsUrl } = parseArgs();

  log('Starting MCP stdio-to-WebSocket bridge');
  log(`WebSocket URL: ${wsUrl}`);

  const bridge = new StdioBridge(wsUrl);

  try {
    await bridge.start();
  } catch (error) {
    log('Failed to start bridge:', error);
    process.exit(1);
  }
}

main();
