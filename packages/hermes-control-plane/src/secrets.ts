/**
 * Cached Secrets Manager fetch — mirrors the pattern used in the MCP HTTP handler
 * (lazy fetch + in-process cache). Secrets hold JSON; missing/empty values are tolerated
 * so the service runs before credentials are populated.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, Record<string, string>>();

export async function getSecretJson(name: string): Promise<Record<string, string>> {
  const cached = cache.get(name);
  if (cached) return cached;
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const parsed = JSON.parse(res.SecretString || '{}') as Record<string, string>;
    cache.set(name, parsed);
    return parsed;
  } catch {
    return {};
  }
}

export function clearSecretCache(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}
