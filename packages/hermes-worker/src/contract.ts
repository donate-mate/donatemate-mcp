/**
 * WS3.2 / WS3.3 — the repo-versioned Hermes contract (HERMES.md) and PR-body validation.
 *
 * HERMES.md lives at the root of the target repo (merged separately, e.g. donatemate PR #754). It
 * is the single source of truth for how Hermes must behave in THAT repo — injected verbatim into
 * the agent prompt so the contract travels with the code and can evolve without redeploying the
 * worker. If it's absent we log and proceed (forward/backward compatible).
 *
 * §8 of HERMES.md defines six required outcome-report sections. Before opening a PR we regex-check
 * the body contains them; a missing report triggers one retry, then we open with a loud marker.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONTRACT_FILENAME = process.env.HERMES_CONTRACT_FILENAME || 'HERMES.md';

/** The six required outcome-report sections from HERMES.md §8. */
export const REQUIRED_PR_SECTIONS = [
  'Root cause',
  'Evidence',
  'Verification',
  'Blast radius',
  'Data repair',
  'Deferred',
] as const;

/** Read HERMES.md from the clone root. Returns undefined (and logs) when absent. */
export async function loadContract(dir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(dir, CONTRACT_FILENAME), 'utf8')).trim();
    if (!text) return undefined;
    console.log(`[contract] injected ${CONTRACT_FILENAME} (${text.length} chars)`);
    return text;
  } catch {
    console.warn(`[contract] ${CONTRACT_FILENAME} not found in repo root — proceeding without it`);
    return undefined;
  }
}

/** Wrap the contract so the agent treats it as authoritative, appended after the harness preamble. */
export function contractPromptBlock(contract: string): string {
  return [
    '--- REPOSITORY CONTRACT (HERMES.md) ---',
    'The following contract is versioned in this repository and is AUTHORITATIVE. Follow it exactly,',
    'including any required PR outcome-report sections.',
    '',
    contract,
    '--- END REPOSITORY CONTRACT ---',
  ].join('\n');
}

export interface BodyValidation {
  ok: boolean;
  missing: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Check a PR body / outcome report contains each required section heading. */
export function validatePrBody(body: string): BodyValidation {
  const missing = REQUIRED_PR_SECTIONS.filter((section) => {
    // Match "## Root cause", "**Root cause:**", "Root cause -", etc. — heading-ish occurrences.
    const re = new RegExp(`(^|\\n)\\s*[#*_>\\-\\s]*${escapeRegExp(section)}`, 'i');
    return !re.test(body);
  });
  return { ok: missing.length === 0, missing };
}

/** True only when review feedback explicitly asks Hermes to change live PR metadata. */
export function feedbackRequestsPrBodyUpdate(feedback?: string): boolean {
  if (!feedback) return false;
  return /\b(?:PR|pull request)\s+(?:body|description)\b|\blive merge record\b|\boutcome report\b/i.test(feedback);
}

/** Extract a complete six-section outcome report from an agent's final response. */
export function extractOutcomeReport(text?: string): string | undefined {
  if (!text) return undefined;
  const start = text.search(/^##\s+Root cause\b/im);
  if (start < 0) return undefined;
  const report = text.slice(start).trim();
  return validatePrBody(report).ok ? report : undefined;
}

/** Prompt asking the agent to (re)produce the outcome report with the missing sections. */
export function buildReportRepairPrompt(missing: string[], contract?: string): string {
  return [
    'Before this PR can open, produce the outcome report required by the repository contract.',
    `The report is MISSING these required sections: ${missing.join(', ')}.`,
    '',
    'Write the complete outcome report as a Markdown block with a level-2 heading for EACH of these',
    `sections: ${REQUIRED_PR_SECTIONS.join(', ')}. Base it on the change you just made. Put the report`,
    'in a file named `HERMES_REPORT.md` at the repo root (the harness reads it into the PR body).',
    contract ? '\nFollow HERMES.md §8 for the exact expected content of each section.' : '',
    '\nDo not run git commands; leave the file in the working tree.',
  ].join('\n');
}

/** After a report-repair round, read the agent's HERMES_REPORT.md if it wrote one. */
export async function loadReport(dir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(dir, 'HERMES_REPORT.md'), 'utf8')).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
