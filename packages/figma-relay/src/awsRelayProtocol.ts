export const AWS_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1_000;
export const AWS_REGISTRATION_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const AWS_RECONNECT_BASE_DELAY_MS = 5_000;
export const AWS_RECONNECT_MAX_DELAY_MS = 60_000;

export function buildJsonRpcRequest(
  method: string,
  id: string,
  params?: Record<string, unknown>
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params ? { params } : {}),
  };
}

export function reconnectDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 30));
  return Math.min(
    AWS_RECONNECT_MAX_DELAY_MS,
    AWS_RECONNECT_BASE_DELAY_MS * (2 ** exponent)
  );
}

export function describeAwsMessage(message: Record<string, unknown>): string {
  if (typeof message.type === 'string') {
    return message.type;
  }
  if (typeof message.method === 'string') {
    return message.method;
  }
  if (typeof message.id === 'string' && message.id.startsWith('relay_register_')) {
    return message.error ? 'registration rejected' : 'registration acknowledged';
  }
  if (typeof message.id === 'string' && message.id.startsWith('relay_ping_')) {
    return message.error ? 'heartbeat rejected' : 'heartbeat acknowledged';
  }
  if (message.error) {
    return 'JSON-RPC error';
  }
  return 'JSON-RPC response';
}
