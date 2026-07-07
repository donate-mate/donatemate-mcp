/**
 * --- WS5 --- Readiness gates: ticket checklist (WS5.3) and evidence-ID verification (WS5.4).
 *
 * Pure, deterministic helpers — no I/O. The control plane fetches the PR body + comments and asks
 * these functions whether the PR has satisfied every acceptance item and referenced the required
 * staging record IDs before the watch is allowed to move to Ready for review.
 */

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// --- WS5 --- Render a checklist as an unchecked Markdown section for posting on the PR.
export function renderChecklist(items: string[]): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (!clean.length) return '';
  return ['## Hermes checklist', ...clean.map((i) => `- [ ] ${i}`)].join('\n');
}

const FOLLOWUP_KEY = /DM-\d+/i;

// --- WS5 --- An item is satisfied when a checked box (`- [x]`) fuzzy-matches it, or when it is
// explicitly deferred to a follow-up ticket (DM-####) on the same line.
export function evaluateChecklist(items: string[], text: string): { satisfied: boolean; missing: string[] } {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (!clean.length) return { satisfied: true, missing: [] };

  const lines = text.split(/\r?\n/);
  const checked = lines
    .filter((l) => /^\s*[-*]\s*\[x\]/i.test(l))
    .map((l) => normalize(l.replace(/^\s*[-*]\s*\[x\]/i, '')));
  const deferredLines = lines.filter((l) => FOLLOWUP_KEY.test(l)).map((l) => normalize(l));

  const missing: string[] = [];
  for (const item of clean) {
    const n = normalize(item);
    if (!n) continue;
    const isChecked = checked.some((c) => c && (c.includes(n) || n.includes(c)));
    const isDeferred = deferredLines.some((d) => d.includes(n));
    if (!isChecked && !isDeferred) missing.push(item);
  }
  return { satisfied: missing.length === 0, missing };
}

const EVIDENCE_ID_PATTERNS: RegExp[] = [
  /\b(?:donation|request|txn|transaction)[ _-]?id[:=]?\s*([A-Za-z0-9-]{6,})/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
];

// --- WS5 --- Extract staging record IDs (donation/request/txn ids + bare UUIDv4) from the ticket.
export function extractEvidenceIds(issueContext: string): string[] {
  const found = new Set<string>();
  for (const pattern of EVIDENCE_ID_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(issueContext)) !== null) {
      const id = (m[1] ?? m[0]).trim();
      if (id.length >= 6) found.add(id);
    }
  }
  return [...found];
}

// --- WS5 --- When a ticket carries evidence IDs, the PR must contain a "Data repair"/"Evidence"
// section that references every ID with a before/after. Returns which IDs are still unreferenced.
export function evaluateEvidence(ids: string[], text: string): { satisfied: boolean; missing: string[] } {
  if (!ids.length) return { satisfied: true, missing: [] };
  const lower = text.toLowerCase();
  const hasSection = /(data repair|evidence)/i.test(text);
  const hasBeforeAfter = /before/i.test(text) && /after/i.test(text);
  const missing = ids.filter((id) => !lower.includes(id.toLowerCase()));
  return { satisfied: hasSection && hasBeforeAfter && missing.length === 0, missing };
}
