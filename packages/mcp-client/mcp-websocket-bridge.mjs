#!/usr/bin/env node
/**
 * MCP WebSocket Bridge
 * Bridges stdio (used by Claude Desktop) to WebSocket (used by DonateMate MCP server)
 */

let WebSocket;
try {
  WebSocket = (await import('ws')).default;
} catch (e) {
  process.stderr.write(`[MCP Bridge] Failed to import ws module: ${e.message}\n`);
  process.stderr.write(`[MCP Bridge] Node path: ${process.execPath}\n`);
  process.stderr.write(`[MCP Bridge] Script path: ${import.meta.url}\n`);
  process.exit(1);
}

import readline from 'readline';

const WS_URL = process.argv[2];
process.stderr.write(`[MCP Bridge] Starting with URL length: ${WS_URL ? WS_URL.length : 0}\n`);
process.stderr.write(`[MCP Bridge] URL start: ${WS_URL ? WS_URL.substring(0, 80) : 'MISSING'}\n`);
process.stderr.write(`[MCP Bridge] URL end: ${WS_URL ? WS_URL.substring(WS_URL.length - 50) : 'MISSING'}\n`);

if (!WS_URL) {
  console.error('Usage: node mcp-websocket-bridge.mjs <websocket-url>');
  process.exit(1);
}

let ws;
let pendingMessages = [];
let wsReady = false;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    process.stderr.write('[MCP Bridge] Connected to WebSocket server\n');
    wsReady = true;
    // Send any messages that arrived before connection was ready
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      process.stderr.write(`[MCP Bridge] Sending buffered message: ${msg.substring(0, 50)}...\n`);
      ws.send(msg);
    }
  });

  ws.on('message', (data) => {
    const message = data.toString();
    process.stderr.write(`[MCP Bridge] Received from WebSocket (full): ${message}\n`);
    // Write to stdout for Claude Desktop to read
    process.stdout.write(message + '\n');
    process.stderr.write(`[MCP Bridge] Wrote to stdout\n`);
  });

  ws.on('error', (error) => {
    process.stderr.write(`[MCP Bridge] WebSocket error: ${error.message}\n`);
  });

  ws.on('close', (code, reason) => {
    process.stderr.write(`[MCP Bridge] WebSocket closed: ${code} ${reason}\n`);
    process.exit(0);
  });
}

// Read from stdin (Claude Desktop sends messages here)
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  process.stderr.write(`[MCP Bridge] Received from stdin: ${line.substring(0, 100)}...\n`);
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(line);
    process.stderr.write(`[MCP Bridge] Sent to WebSocket\n`);
  } else {
    process.stderr.write(`[MCP Bridge] WebSocket not ready, buffering message\n`);
    pendingMessages.push(line);
  }
});

let stdinClosed = false;

rl.on('close', () => {
  process.stderr.write('[MCP Bridge] stdin closed\n');
  stdinClosed = true;
  // Don't exit immediately if we have pending messages - wait for WebSocket
  if (pendingMessages.length === 0 && ws) {
    ws.close();
    process.exit(0);
  }
});

// Handle process termination
process.on('SIGINT', () => {
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (ws) ws.close();
  process.exit(0);
});

connect();
