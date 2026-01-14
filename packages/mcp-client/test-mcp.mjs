import WebSocket from 'ws';

const WS_URL = process.argv[2];
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.error('[Connected]');
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-client', version: '1.0.0' },
      capabilities: {}
    }
  };
  ws.send(JSON.stringify(initRequest));
});

ws.on('message', (data) => {
  console.log('[Response]', data.toString());
  const msg = JSON.parse(data.toString());
  if (msg.id === 1) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  } else if (msg.id === 2) {
    ws.close();
  }
});

ws.on('error', (e) => console.error('[Error]', e.message));
ws.on('close', () => { console.error('[Closed]'); process.exit(0); });
setTimeout(() => { ws.close(); process.exit(0); }, 10000);
