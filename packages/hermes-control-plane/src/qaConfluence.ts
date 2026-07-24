import { getSecretJson } from './secrets.js';

const SECRET = process.env.SECRET_JIRA_BOT || process.env.SECRET_JIRA;
const DEFAULT_SPACE_KEY = process.env.QA_CONFLUENCE_SPACE_KEY || 'SD';

const DOMAIN_CODES = ['AUTH', 'ONB', 'DON', 'SRCH', 'DASH', 'SOC', 'GOAL', 'XCUT'] as const;
const SCENARIO_ID_RE = /\bTS-([A-Z]+)-([A-Z0-9-]+)-(\d{3,})\b/g;

export type QaScenarioStatus = 'Executable' | 'Defect-held' | 'Staged' | 'Unknown';

export interface QaScenario {
  id: string;
  title: string;
  domain: string;
  feature: string;
  number: number;
  priority: string;
  platforms: string[];
  relatedTickets: string[];
  status: QaScenarioStatus;
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  text: string;
}

export interface QaScenarioPage {
  id: string;
  title: string;
  webUrl: string;
  status: QaScenarioStatus;
  bodyText: string;
}

export interface QaScenarioCatalog {
  loadedAt: string;
  spaceKey: string;
  pages: QaScenarioPage[];
  scenarios: QaScenario[];
}

interface ConfluenceCreds {
  host: string;
  auth: string;
}

interface ConfluenceSearchResult {
  id: string;
  title: string;
  _links?: { webui?: string };
}

interface ConfluenceContent {
  id: string;
  title: string;
  version?: { number?: number };
  space?: { key?: string };
  _links?: { webui?: string };
  body?: { storage?: { value?: string } };
}

async function creds(): Promise<ConfluenceCreds | null> {
  if (!SECRET) return null;
  const { host, email, token } = await getSecretJson(SECRET);
  if (!host || !email || !token) return null;
  return { host: host.replace(/\/$/, ''), auth: Buffer.from(`${email}:${token}`).toString('base64') };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pageStatus(text: string): QaScenarioStatus {
  const status = text.match(/\bStatus:\s*(Executable|Defect-held|Staged)\b/i)?.[1];
  if (!status) return 'Unknown';
  const normalized = status.toLowerCase();
  if (normalized === 'executable') return 'Executable';
  if (normalized === 'defect-held') return 'Defect-held';
  return 'Staged';
}

function parseListValue(block: string, label: string): string[] {
  const match = block.match(new RegExp(`${label}:\\s*([^\\n]+)`, 'i'));
  if (!match) return [];
  return match[1]
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseScenarioBlock(
  id: string,
  title: string,
  block: string,
  page: QaScenarioPage
): QaScenario {
  const [, domain = 'UNK', feature = 'general', number = '0'] = id.match(/^TS-([A-Z]+)-([A-Z0-9-]+)-(\d+)$/) ?? [];
  const priority = block.match(/\bPriority:\s*(P[0-3])\b/i)?.[1]?.toUpperCase() ?? 'P2';
  const relatedTickets = [...new Set(block.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
  const localStatus = block.match(/\bStatus:\s*(Executable|Defect-held|Staged)\b/i)?.[1] as QaScenarioStatus | undefined;
  return {
    id,
    title: normalize(title || id),
    domain,
    feature,
    number: Number(number),
    priority,
    platforms: parseListValue(block, 'Platforms'),
    relatedTickets,
    status: localStatus ?? page.status,
    pageId: page.id,
    pageTitle: page.title,
    pageUrl: page.webUrl,
    text: block.trim().slice(0, 4000),
  };
}

function parseScenarios(page: QaScenarioPage): QaScenario[] {
  const lines = page.bodyText.split('\n');
  const headingIndexes: Array<{ line: number; id: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:#{1,6}\s*)?(TS-[A-Z]+-[A-Z0-9-]+-\d{3,})\s*:?\s*(.*)$/);
    if (match) headingIndexes.push({ line: i, id: match[1], title: match[2] || match[1] });
  }

  if (headingIndexes.length) {
    return headingIndexes.map((h, i) => {
      const next = headingIndexes[i + 1]?.line ?? lines.length;
      return parseScenarioBlock(h.id, h.title, lines.slice(h.line, next).join('\n'), page);
    });
  }

  const ids = [...new Set([...page.bodyText.matchAll(SCENARIO_ID_RE)].map((m) => m[0]))];
  return ids.map((id) => parseScenarioBlock(id, id, page.bodyText, page));
}

async function confluenceFetch<T>(path: string): Promise<T> {
  const c = await creds();
  if (!c) throw new Error('Confluence credentials are not configured');
  const res = await fetch(`${c.host}/wiki${path}`, {
    headers: { Authorization: `Basic ${c.auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Confluence HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function confluenceWrite<T>(path: string, body: unknown): Promise<T> {
  const c = await creds();
  if (!c) throw new Error('Confluence credentials are not configured');
  const res = await fetch(`${c.host}/wiki${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${c.auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Confluence write HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function searchPages(cql: string): Promise<ConfluenceSearchResult[]> {
  const data = await confluenceFetch<{ results?: ConfluenceSearchResult[] }>(
    `/rest/api/content/search?limit=100&cql=${encodeURIComponent(cql)}`
  );
  return data.results ?? [];
}

async function fetchPage(pageId: string): Promise<ConfluenceContent> {
  return confluenceFetch<ConfluenceContent>(
    `/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`
  );
}

function absolutePageUrl(host: string, webui?: string): string {
  if (!webui) return host;
  return webui.startsWith('http') ? webui : `${host.replace(/\/$/, '')}/wiki${webui}`;
}

export async function assertConfluenceAccess(): Promise<void> {
  await searchPages(`space = ${DEFAULT_SPACE_KEY} AND type = page AND title ~ "QA"`);
}

export async function loadQaScenarioCatalog(spaceKey = DEFAULT_SPACE_KEY): Promise<QaScenarioCatalog> {
  const c = await creds();
  if (!c) throw new Error('Confluence credentials are not configured');
  const pageIds = new Set<string>();

  const queries = [
    `space = ${spaceKey} AND type = page AND title ~ "Scenarios"`,
    ...DOMAIN_CODES.map((domain) => `space = ${spaceKey} AND type = page AND text ~ "TS-${domain}"`),
  ];

  for (const query of queries) {
    const pages = await searchPages(query).catch(() => []);
    for (const page of pages) pageIds.add(page.id);
  }

  const pages: QaScenarioPage[] = [];
  for (const id of pageIds) {
    const page = await fetchPage(id).catch(() => undefined);
    if (!page?.body?.storage?.value) continue;
    const bodyText = htmlToText(page.body.storage.value);
    if (!SCENARIO_ID_RE.test(bodyText) && !/\bScenarios\b/i.test(page.title)) continue;
    SCENARIO_ID_RE.lastIndex = 0;
    pages.push({
      id: page.id,
      title: page.title,
      webUrl: absolutePageUrl(c.host, page._links?.webui),
      status: pageStatus(bodyText),
      bodyText,
    });
  }

  const scenarios = pages.flatMap(parseScenarios).filter((s, idx, all) => all.findIndex((x) => x.id === s.id) === idx);
  scenarios.sort((a, b) => a.id.localeCompare(b.id));

  return {
    loadedAt: new Date().toISOString(),
    spaceKey,
    pages: pages.sort((a, b) => a.title.localeCompare(b.title)),
    scenarios,
  };
}

function markdownToStorageHtml(markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

export async function appendScenarioToPage(pageId: string, scenarioMarkdown: string, versionMessage: string): Promise<string> {
  const page = await fetchPage(pageId);
  if (!page.body?.storage?.value || !page.version?.number) throw new Error(`Confluence page ${pageId} is missing storage body/version`);
  const nextBody = `${page.body.storage.value}\n<hr />\n${markdownToStorageHtml(scenarioMarkdown)}`;
  const updated = await confluenceWrite<ConfluenceContent>(`/rest/api/content/${encodeURIComponent(pageId)}`, {
    id: page.id,
    type: 'page',
    title: page.title,
    space: { key: page.space?.key ?? DEFAULT_SPACE_KEY },
    version: { number: page.version.number + 1, message: versionMessage },
    body: { storage: { value: nextBody, representation: 'storage' } },
  });
  const c = await creds();
  return absolutePageUrl(c?.host ?? '', updated._links?.webui ?? page._links?.webui);
}
