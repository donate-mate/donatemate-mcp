/**
 * Cached Secrets Manager fetch (same pattern as the control plane / MCP HTTP handler).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, Record<string, string>>();
const stringCache = new Map<string, string>();

export async function getSecretJson(name: string): Promise<Record<string, string>> {
  const cached = cache.get(name);
  if (cached) return cached;
  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  const parsed = JSON.parse(res.SecretString || '{}') as Record<string, string>;
  cache.set(name, parsed);
  return parsed;
}

/** Plain-string secret (e.g. the Anthropic API key, stored as a raw string not JSON). */
export async function getSecretString(name: string): Promise<string> {
  const cached = stringCache.get(name);
  if (cached !== undefined) return cached;
  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  const value = (res.SecretString || '').trim();
  stringCache.set(name, value);
  return value;
}
