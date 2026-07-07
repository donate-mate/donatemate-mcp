/**
 * WS4 — Pre-open adversarial review stage.
 *
 * After the gate passes and the change is committed locally, a SECOND independent Codex session
 * (reasoning HIGH) is asked to REFUTE the fix. It reads the diff + ticket + HERMES.md and hunts for
 * the failure modes the human review pass found repeatedly: fixing a symptom one layer downstream of
 * the true writer, incomplete ticket coverage, uncovered new-parameter callers, unrepaired persisted
 * data corruption, missing API contract artifacts, and semantic conflicts with other open Hermes PRs.
 *
 * It outputs findings JSON. BLOCKING findings drive exactly ONE fix round in the implementation
 * session, then the gate re-runs and the PR opens. Hard caps: 1 review session + 1 fix round pre-open
 * (the post-open reconcile loop is unchanged). Controlled by PREOPEN_REVIEW_ENABLED.
 */
import { runAgent } from './agent.js';
import { getDiff, discardWorkingTreeChanges } from './github.js';

export const PREOPEN_REVIEW_ENABLED = (process.env.PREOPEN_REVIEW_ENABLED ?? 'true').toLowerCase() !== 'false';
const REVIEW_EFFORT = process.env.PREOPEN_REVIEW_EFFORT || 'high';

export interface ReviewFinding {
  severity: 'BLOCKING' | 'ADVISORY';
  file?: string;
  line?: number;
  claim: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  /** raw model output, for the transcript when JSON parsing fails */
  raw: string;
  ran: boolean;
}

const REVIEW_PREAMBLE = `You are an adversarial code reviewer inside an automated CI harness. You are reviewing a change another agent just made, BEFORE its PR opens. Your ONLY job is to find defects — do NOT edit files, do NOT run git, do NOT open a PR. Read the repository as needed to verify your claims, then output your findings.

Attempt to REFUTE the change on each of these dimensions:
- Root-cause adequacy: is the FIRST writer of the bad state fixed, or only a downstream symptom?
- Ticket completeness: is every enumerated item in the ticket (including items raised in Jira comments) addressed?
- Caller coverage: for any new/changed function parameter, are ALL call sites updated?
- Data repair: if corrupted data was persisted, is there a repair/migration for existing records, not just a forward fix?
- Contract artifacts: for API changes, are the OpenAPI/SDK/typed-client artifacts updated?
- Semantic conflicts: does this contradict or depend on any of the listed open Hermes PRs?

Output ONLY a JSON array (no prose, no code fences) of findings, each:
{"severity":"BLOCKING"|"ADVISORY","file":"path","line":123,"claim":"one sentence"}
Use BLOCKING only for defects that should stop the PR from opening. If the change is sound, output [].

--- REVIEW INPUT ---

`;

/** Extract a JSON array of findings from possibly-fenced model output. */
export function parseFindings(raw: string): ReviewFinding[] {
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      return parsed
        .filter((f) => f && typeof f.claim === 'string')
        .map((f) => ({
          severity: f.severity === 'BLOCKING' ? 'BLOCKING' : 'ADVISORY',
          file: typeof f.file === 'string' ? f.file : undefined,
          line: Number.isFinite(f.line) ? Number(f.line) : undefined,
          claim: String(f.claim).slice(0, 500),
        }));
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

export interface ReviewContext {
  dir: string;
  baseSha: string;
  ticketContext?: string;
  contract?: string;
  /** Summaries of overlapping open Hermes PRs (WS5.1), if any. */
  overlapContext?: string;
}

/**
 * Run the review session and return findings. The caller MUST have committed the real change before
 * calling this — we discard the review session's working-tree edits afterward so a read-only review
 * that strays into editing cannot pollute the diff.
 */
export async function runPreopenReview(ctx: ReviewContext): Promise<ReviewResult> {
  if (!PREOPEN_REVIEW_ENABLED) return { findings: [], raw: '', ran: false };

  const diff = await getDiff(ctx.dir, ctx.baseSha);
  if (!diff.trim()) return { findings: [], raw: '', ran: false };

  const input = [
    ctx.ticketContext ? `## Ticket\n${ctx.ticketContext}` : undefined,
    ctx.contract ? `## Repository contract (HERMES.md)\n${ctx.contract}` : undefined,
    ctx.overlapContext ? `## Open Hermes PRs that touch overlapping files\n${ctx.overlapContext}` : undefined,
    '## Diff under review',
    '```diff',
    diff,
    '```',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await runAgent(ctx.dir, input, { preamble: REVIEW_PREAMBLE, reasoningEffort: REVIEW_EFFORT });
  // Drop anything the review session touched — the real change is already committed.
  await discardWorkingTreeChanges(ctx.dir);

  const raw = result.finalMessage ?? '';
  return { findings: parseFindings(raw), raw, ran: true };
}

/** Prompt to fix the BLOCKING findings in the implementation session (one round only). */
export function buildReviewFixPrompt(findings: ReviewFinding[]): string {
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  return [
    'A pre-open adversarial review found BLOCKING issues with your change. Fix each one directly and',
    'optimally (address the true root cause; do not just silence the symptom). Do not run git commands.',
    '',
    ...blocking.map((f, i) => `${i + 1}. ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}${f.claim}`),
  ].join('\n');
}

/** Human-readable review summary for the PR body. */
export function reviewSummary(findings: ReviewFinding[], fixed: number, disputed: number): string {
  if (!findings.length) return 'Pre-open review: no findings.';
  const lines = [`Pre-open review: ${findings.length} finding(s), ${fixed} fixed, ${disputed} disputed.`, ''];
  for (const f of findings) {
    lines.push(`- **${f.severity}** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}— ${f.claim}`);
  }
  return lines.join('\n');
}
