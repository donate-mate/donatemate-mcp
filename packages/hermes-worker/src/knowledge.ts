/**
 * WS6 (injection half) — query the DonateMate knowledge base at job start and inject the top-K
 * "previously flagged patterns in this area" into the agent prompt.
 *
 * The knowledge base is Postgres+pgvector, reachable only through the DonateMate MCP server's
 * `dm_knowledge_search` tool. The worker already carries MCP_ENDPOINT + the MCP API key
 * (SECRET_DM_MCP), and it is where the final prompt is assembled (Jira context is merged here too),
 * so the query happens worker-side rather than in the control plane (which lacks the MCP key).
 *
 * Entirely fail-open and gated by KB_INJECTION_ENABLED: any error (endpoint down, MCP handshake
 * change, auth) returns '' and the job proceeds without the hint block.
 */
import { getSecretJson } from './secrets.js';

const KB_INJECTION_ENABLED = (process.env.KB_INJECTION_ENABLED ?? 'true').toLowerCase() !== 'false';
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || '';
const SECRET_DM_MCP = process.env.SECRET_DM_MCP;
const KB_TOP_K = Number(process.env.KB_TOP_K ?? 5);
const KB_TIMEOUT_MS = Number(process.env.KB_TIMEOUT_SECONDS ?? 15) * 1000;

let cachedKey: string | undefined;
async function mcpApiKey(): Promise<string | undefined> {
  if (cachedKey !== undefined) return cachedKey;
  if (!SECRET_DM_MCP) return (cachedKey = '');
  try {
    const secret = await getSecretJson(SECRET_DM_MCP);
    cachedKey = secret.apiKey || secret.key || secret.token || '';
  } catch {
    cachedKey = '';
  }
  return cachedKey;
}

/** Parse a streamable-HTTP MCP response, which may be JSON or an SSE `event:/data:` frame. */
function parseMcpBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  // SSE: take the last `data:` line.
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  const last = dataLines[dataLines.length - 1];
  return last ? JSON.parse(last) : undefined;
}

async function mcpRpc(sessionId: string | undefined, key: string | undefined, method: string, params: unknown): Promise<{ body: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (key) {
    headers['authorization'] = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KB_TIMEOUT_MS);
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const returnedSession = res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    return { body: text ? parseMcpBody(text) : undefined, sessionId: returnedSession };
  } finally {
    clearTimeout(timer);
  }
}

interface KbHit {
  title?: string;
  path?: string;
  snippet?: string;
  score?: number;
}

/** Best-effort call to dm_knowledge_search. Returns [] on any failure. */
async function searchKnowledge(query: string): Promise<KbHit[]> {
  if (!MCP_ENDPOINT) return [];
  const key = await mcpApiKey();
  try {
    // Minimal MCP streamable-HTTP handshake: initialize → tools/call.
    const init = await mcpRpc(undefined, key, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hermes-worker', version: '1.0' },
    });
    const session = init.sessionId;
    const call = await mcpRpc(session, key, 'tools/call', {
      name: 'dm_knowledge_search',
      arguments: { query, limit: KB_TOP_K },
    });
    const content = call.body?.result?.content;
    if (!Array.isArray(content)) return [];
    const textParts = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    // The tool returns JSON text; parse it, tolerating a plain-text fallback.
    try {
      const parsed = JSON.parse(textParts);
      const rows = Array.isArray(parsed) ? parsed : parsed?.results ?? parsed?.hits ?? [];
      return (rows as any[]).slice(0, KB_TOP_K).map((r) => ({
        title: r.title ?? r.chunk?.title,
        path: r.path ?? r.filePath ?? r.chunk?.filePath,
        snippet: (r.snippet ?? r.content ?? r.chunk?.content ?? '').toString().slice(0, 400),
        score: r.score,
      }));
    } catch {
      return textParts ? [{ snippet: textParts.slice(0, 1000) }] : [];
    }
  } catch (err) {
    console.warn('[knowledge] search failed (proceeding without KB hints):', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Build the "Previously flagged patterns in this area" prompt block from ticket text + area hints.
 * Returns '' when disabled, on error, or when there are no hits.
 */
export async function knowledgePromptBlock(queryText: string, areaHints: string[] = []): Promise<string> {
  if (!KB_INJECTION_ENABLED || !queryText.trim()) return '';
  const query = [queryText, ...areaHints].join(' ').slice(0, 1000);
  const hits = await searchKnowledge(query);
  if (!hits.length) return '';
  const lines = hits.map((h, i) => {
    const where = h.path ? ` (\`${h.path}\`)` : '';
    return `${i + 1}. ${h.title ?? 'Prior finding'}${where}: ${h.snippet ?? ''}`.trim();
  });
  return [
    '--- PREVIOUSLY FLAGGED PATTERNS IN THIS AREA ---',
    'Reviewers previously flagged these in related code. Avoid repeating them:',
    '',
    ...lines,
    '--- END PREVIOUSLY FLAGGED PATTERNS ---',
  ].join('\n');
}
