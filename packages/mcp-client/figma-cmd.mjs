import WebSocket from 'ws';
const WS_URL = process.argv[2];
const toolName = process.argv[3];
const toolArgs = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const ws = new WebSocket(WS_URL);
ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'cli', version: '1.0' }, capabilities: {} }
  }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id === 1) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }));
  } else if (msg.id === 2) {
    if (msg.result?.content?.[0]?.text) {
      console.log(msg.result.content[0].text);
    } else if (msg.error) {
      console.log(JSON.stringify(msg.error, null, 2));
    }
    ws.close();
  }
});
ws.on('error', (e) => { console.error('Error:', e.message); process.exit(1); });
ws.on('close', () => process.exit(0));
setTimeout(() => { ws.close(); process.exit(1); }, 30000);
