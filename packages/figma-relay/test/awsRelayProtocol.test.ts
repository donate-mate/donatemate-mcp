import { describe, expect, it } from 'vitest';
import {
  AWS_HEARTBEAT_INTERVAL_MS,
  AWS_REGISTRATION_REFRESH_INTERVAL_MS,
  buildJsonRpcRequest,
  describeAwsMessage,
  reconnectDelay,
} from '../src/awsRelayProtocol.js';

describe('AWS relay protocol', () => {
  it('builds an identified ping request before the API Gateway idle timeout', () => {
    expect(AWS_HEARTBEAT_INTERVAL_MS).toBeLessThan(10 * 60 * 1_000);
    expect(AWS_REGISTRATION_REFRESH_INTERVAL_MS).toBeLessThan(24 * 60 * 60 * 1_000);
    expect(buildJsonRpcRequest('ping', 'relay_ping_123')).toEqual({
      jsonrpc: '2.0',
      id: 'relay_ping_123',
      method: 'ping',
    });
  });

  it('labels registration and heartbeat acknowledgements instead of logging undefined', () => {
    expect(describeAwsMessage({
      jsonrpc: '2.0',
      id: 'relay_register_123',
      result: { registered: true, type: 'figma' },
    })).toBe('registration acknowledged');
    expect(describeAwsMessage({
      jsonrpc: '2.0',
      id: 'relay_ping_123',
      result: {},
    })).toBe('heartbeat acknowledged');
  });

  it('backs off repeated reconnects and caps the delay', () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelay)).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      60_000,
      60_000,
    ]);
  });
});
