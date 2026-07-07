import { draftQaScenario } from './converse.js';
import { appendScenarioToPage, loadQaScenarioCatalog, type QaScenario, type QaScenarioCatalog } from './qaConfluence.js';
import type { JiraIssue } from './jira.js';

export interface QaCaptureResult {
  status: 'existing' | 'created' | 'na' | 'needs_human';
  message: string;
  scenarioId?: string;
  pageUrl?: string;
}

const DOMAIN_HINTS: Array<{ domain: string; terms: RegExp[] }> = [
  { domain: 'AUTH', terms: [/auth/i, /login/i, /sign[ -]?in/i, /sign[ -]?up/i, /password/i, /otp/i, /session/i] },
  { domain: 'ONB', terms: [/onboard/i, /account type/i, /organization setup/i] },
  { domain: 'DON', terms: [/donation/i, /receipt/i, /document/i, /manual entry/i, /ocr/i] },
  { domain: 'SRCH', terms: [/search/i, /people/i, /charit/i] },
  { domain: 'DASH', terms: [/dashboard/i, /impact/i, /home summary/i] },
  { domain: 'SOC', terms: [/social/i, /feed/i, /post/i, /follow/i, /profile/i] },
  { domain: 'GOAL', terms: [/goal/i] },
  { domain: 'XCUT', terms: [/toast/i, /banner/i, /date picker/i, /navigation/i, /theme/i, /keyboard/i, /offline/i, /network/i] },
];

function isNoUserFacingQa(issue: JiraIssue): boolean {
  const text = `${issue.issueType}\n${issue.summary}\n${issue.parentSummary ?? ''}\n${issue.labels.join(' ')}\n${issue.context}`;
  return /\bbackend-only|infra-only|spike|documentation only|no user-facing|backend\b/i.test(text) && !/\bfrontend|ui|screen|app\b/i.test(text);
}

function guessDomain(issue: JiraIssue): string {
  const text = `${issue.summary}\n${issue.parentSummary ?? ''}\n${issue.labels.join(' ')}\n${issue.context}`;
  for (const hint of DOMAIN_HINTS) {
    if (hint.terms.some((term) => term.test(text))) return hint.domain;
  }
  return 'XCUT';
}

function chooseTargetScenario(catalog: QaScenarioCatalog, issue: JiraIssue): QaScenario | undefined {
  const issueKey = issue.context.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
  if (issueKey) {
    const related = catalog.scenarios.find((scenario) => scenario.relatedTickets.includes(issueKey));
    if (related) return related;
  }
  const domain = guessDomain(issue);
  return (
    catalog.scenarios.find((scenario) => scenario.domain === domain && scenario.status === 'Executable') ??
    catalog.scenarios.find((scenario) => scenario.domain === domain) ??
    catalog.scenarios.find((scenario) => scenario.status === 'Executable')
  );
}

function nextScenarioId(catalog: QaScenarioCatalog, target: QaScenario, domain: string): string {
  const feature = target.feature || 'general';
  const siblings = catalog.scenarios.filter((scenario) => scenario.domain === domain && scenario.feature === feature);
  const next = Math.max(0, ...siblings.map((scenario) => scenario.number)) + 1;
  return `TS-${domain}-${feature}-${String(next).padStart(3, '0')}`;
}

export async function captureQaScenarioForDone(issueKey: string, issue: JiraIssue): Promise<QaCaptureResult> {
  if (isNoUserFacingQa(issue)) {
    return {
      status: 'na',
      message: `QA scenario: N/A for ${issueKey} because the ticket appears backend-only, infra-only, or non-user-facing.`,
    };
  }

  const catalog = await loadQaScenarioCatalog();
  const existing = catalog.scenarios.find((scenario) => scenario.relatedTickets.includes(issueKey));
  if (existing) {
    return {
      status: 'existing',
      scenarioId: existing.id,
      pageUrl: existing.pageUrl,
      message: `QA scenario already recorded for ${issueKey}: ${existing.id} (${existing.pageTitle}).`,
    };
  }

  const target = chooseTargetScenario(catalog, issue);
  if (!target) {
    return {
      status: 'needs_human',
      message: `QA scenario capture could not find an appropriate Confluence scenario page for ${issueKey}. A developer should add the scenario manually.`,
    };
  }

  const scenarioId = nextScenarioId(catalog, target, target.domain);
  const draft = await draftQaScenario(issue.context, scenarioId, target.pageTitle);
  if (!draft || draft.trim().toUpperCase() === 'N/A') {
    return {
      status: 'na',
      message: `QA scenario: N/A for ${issueKey}. Hermes did not identify user-facing behavior that needs a scenario.`,
    };
  }
  const normalizedDraft = [
    draft.includes(scenarioId) ? undefined : `### ${scenarioId}: ${issue.summary}`,
    /\bRelated tickets:/i.test(draft) ? undefined : `Related tickets: ${issueKey}`,
    draft.includes(issueKey) ? undefined : `Traceability: ${issueKey}`,
    draft,
  ]
    .filter(Boolean)
    .join('\n\n');

  const pageUrl = await appendScenarioToPage(
    target.pageId,
    normalizedDraft,
    `Hermes scenario capture for ${issueKey} (${scenarioId})`
  );
  return {
    status: 'created',
    scenarioId,
    pageUrl,
    message: `QA scenario captured for ${issueKey}: ${scenarioId} on ${target.pageTitle}.`,
  };
}
