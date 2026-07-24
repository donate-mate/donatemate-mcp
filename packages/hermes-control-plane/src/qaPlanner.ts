import type { PrWatch } from './prWatch.js';
import type { QaScenario, QaScenarioCatalog } from './qaConfluence.js';

export type QaScenarioSelectionKind = 'direct' | 'regression';
export type QaAutomationStatus = 'mapped' | 'missing';

export interface QaSelectedScenario {
  id: string;
  title: string;
  domain: string;
  feature: string;
  priority: string;
  platforms: string[];
  status: string;
  pageTitle: string;
  pageUrl: string;
  selection: QaScenarioSelectionKind;
  reason: string;
  automationStatus: QaAutomationStatus;
  automationPath?: string;
}

export interface QaProofPlan {
  version: 1;
  mode: 'full_catalog_post_merge';
  automationDisabled?: boolean;
  createdAt: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  mergeCommitSha: string;
  baseBranch: string;
  issueKey?: string;
  build: {
    workflowId: string;
    branch: string;
    headSha?: string;
    runUrl?: string;
    recoveredFromMergeCommitSha?: string;
  };
  execution: {
    workflowId: string;
    requireAllExecutableScenarios: boolean;
    requireIosAndAndroid: boolean;
  };
  changedFiles: string[];
  scenarioStats: {
    totalInCatalog: number;
    executable: number;
    selected: number;
    direct: number;
    regression: number;
    missingAutomation: number;
    defectHeld: number;
    staged: number;
  };
  coverageGaps: Array<{ kind: 'missing_direct_scenario'; reason: string }>;
  scenarios: QaSelectedScenario[];
  skipped: Array<{ id: string; reason: string }>;
}

const DOMAIN_FILE_HINTS: Record<string, RegExp[]> = {
  AUTH: [/auth/i, /session/i, /token/i, /login/i, /signup/i, /password/i, /otp/i],
  ONB: [/onboard/i, /accounttype/i, /organization/i],
  DON: [/donation/i, /receipt/i, /document/i, /ocr/i, /manual/i],
  SRCH: [/search/i, /charit/i, /people/i],
  DASH: [/dashboard/i, /impact/i, /home/i],
  SOC: [/social/i, /feed/i, /post/i, /follow/i, /profile/i],
  GOAL: [/goal/i],
  XCUT: [/navigation/i, /theme/i, /toast/i, /banner/i, /date/i, /picker/i, /keyboard/i, /offline/i, /network/i],
};

const AUTOMATION_EXTENSIONS = ['.yaml', '.yml'];
const AUTOMATION_DIR_HINTS = [
  '.maestro',
  '.maestro/flows',
  '.maestro/scenarios',
  'maestro',
  'maestro/flows',
  'docs/qa/automation',
  'qa/maestro',
];

function cleanScenarioId(id: string): string {
  return id.toLowerCase();
}

function automationPathForScenario(scenarioId: string, repoPaths: string[]): string | undefined {
  const id = cleanScenarioId(scenarioId);
  const normalized = repoPaths.map((path) => path.replace(/\\/g, '/'));
  for (const path of normalized) {
    const lower = path.toLowerCase();
    if (!AUTOMATION_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const name = lower.split('/').pop() ?? '';
    if (name === `${id}.yaml` || name === `${id}.yml`) return path;
  }

  for (const dir of AUTOMATION_DIR_HINTS) {
    for (const ext of AUTOMATION_EXTENSIONS) {
      const exact = `${dir}/${id}${ext}`;
      const match = normalized.find((path) => path.toLowerCase() === exact);
      if (match) return match;
    }
  }
  return undefined;
}

function scoreScenario(scenario: QaScenario, changedFiles: string[], issueText: string): { score: number; reason: string } {
  const haystack = `${issueText}\n${changedFiles.join('\n')}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (scenario.relatedTickets.some((key) => haystack.includes(key.toLowerCase()))) {
    score += 6;
    reasons.push('related Jira ticket');
  }
  if (haystack.includes(scenario.domain.toLowerCase()) || haystack.includes(scenario.feature.toLowerCase())) {
    score += 4;
    reasons.push('domain/feature text match');
  }

  const hints = DOMAIN_FILE_HINTS[scenario.domain] ?? [];
  if (changedFiles.some((file) => hints.some((hint) => hint.test(file)))) {
    score += 4;
    reasons.push('changed files touch this domain');
  }

  const featureWords = scenario.feature
    .split(/[-_\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);
  if (featureWords.some((word) => haystack.includes(word.toLowerCase()))) {
    score += 2;
    reasons.push('feature keyword match');
  }

  if (['P0', 'P1'].includes(scenario.priority)) {
    score += 1;
    reasons.push(`${scenario.priority} priority`);
  }

  return { score, reason: reasons.join(', ') || 'full executable catalog regression' };
}

function changesLookUserFacing(changedFiles: string[]): boolean {
  return changedFiles.some((file) =>
    /(^|\/)src\/(features|screens|navigation|components|core\/toasts|theme)\//i.test(file)
  );
}

export function buildQaReadinessPlan(input: {
  watch: PrWatch;
  mergeCommitSha: string;
  buildHeadSha?: string;
  buildRunUrl?: string;
}): QaProofPlan {
  const buildWorkflowId = process.env.QA_BUILD_WORKFLOW_ID || 'staging.yml';
  const executionWorkflowId = process.env.QA_EXECUTION_WORKFLOW_ID || 'hermes-qa.yml';
  return {
    version: 1,
    mode: 'full_catalog_post_merge',
    automationDisabled: true,
    createdAt: new Date().toISOString(),
    repo: input.watch.repo,
    prNumber: input.watch.prNumber,
    prUrl: input.watch.prUrl,
    mergeCommitSha: input.mergeCommitSha,
    baseBranch: input.watch.baseBranch,
    issueKey: input.watch.issueKey || undefined,
    build: {
      workflowId: buildWorkflowId,
      branch: input.watch.baseBranch,
      headSha: input.buildHeadSha,
      runUrl: input.buildRunUrl,
      recoveredFromMergeCommitSha: input.buildHeadSha && input.buildHeadSha !== input.mergeCommitSha ? input.mergeCommitSha : undefined,
    },
    execution: {
      workflowId: executionWorkflowId,
      requireAllExecutableScenarios: false,
      requireIosAndAndroid: false,
    },
    changedFiles: [],
    scenarioStats: {
      totalInCatalog: 0,
      executable: 0,
      selected: 0,
      direct: 0,
      regression: 0,
      missingAutomation: 0,
      defectHeld: 0,
      staged: 0,
    },
    coverageGaps: [],
    scenarios: [],
    skipped: [],
  };
}

export function buildQaProofPlan(input: {
  watch: PrWatch;
  mergeCommitSha: string;
  buildHeadSha?: string;
  buildRunUrl?: string;
  changedFiles: string[];
  repoPaths: string[];
  issueText?: string;
  catalog: QaScenarioCatalog;
}): QaProofPlan {
  const buildWorkflowId = process.env.QA_BUILD_WORKFLOW_ID || 'staging.yml';
  const executionWorkflowId = process.env.QA_EXECUTION_WORKFLOW_ID || 'hermes-qa.yml';
  const issueText = input.issueText ?? input.watch.originalPrompt;
  const executable = input.catalog.scenarios.filter((scenario) => scenario.status === 'Executable');
  const skipped = input.catalog.scenarios
    .filter((scenario) => scenario.status !== 'Executable')
    .map((scenario) => ({ id: scenario.id, reason: `status is ${scenario.status}` }));

  const scenarios = executable.map((scenario) => {
    const { score, reason } = scoreScenario(scenario, input.changedFiles, issueText);
    const automationPath = automationPathForScenario(scenario.id, input.repoPaths);
    const selection: QaScenarioSelectionKind = score >= 4 ? 'direct' : 'regression';
    return {
      id: scenario.id,
      title: scenario.title,
      domain: scenario.domain,
      feature: scenario.feature,
      priority: scenario.priority,
      platforms: scenario.platforms.length ? scenario.platforms : ['iOS', 'Android'],
      status: scenario.status,
      pageTitle: scenario.pageTitle,
      pageUrl: scenario.pageUrl,
      selection,
      reason,
      automationStatus: automationPath ? 'mapped' : 'missing',
      automationPath,
    } satisfies QaSelectedScenario;
  });

  const direct = scenarios.filter((scenario) => scenario.selection === 'direct').length;
  const missingAutomation = scenarios.filter((scenario) => scenario.automationStatus === 'missing').length;
  const coverageGaps =
    direct === 0 && changesLookUserFacing(input.changedFiles)
      ? [
          {
            kind: 'missing_direct_scenario' as const,
            reason:
              'Changed frontend user-facing files, but no existing Confluence scenario matched the ticket, changed files, or feature keywords.',
          },
        ]
      : [];
  return {
    version: 1,
    mode: 'full_catalog_post_merge',
    createdAt: new Date().toISOString(),
    repo: input.watch.repo,
    prNumber: input.watch.prNumber,
    prUrl: input.watch.prUrl,
    mergeCommitSha: input.mergeCommitSha,
    baseBranch: input.watch.baseBranch,
    issueKey: input.watch.issueKey || undefined,
    build: {
      workflowId: buildWorkflowId,
      branch: input.watch.baseBranch,
      headSha: input.buildHeadSha,
      runUrl: input.buildRunUrl,
      recoveredFromMergeCommitSha: input.buildHeadSha && input.buildHeadSha !== input.mergeCommitSha ? input.mergeCommitSha : undefined,
    },
    execution: {
      workflowId: executionWorkflowId,
      requireAllExecutableScenarios: true,
      requireIosAndAndroid: true,
    },
    changedFiles: input.changedFiles,
    scenarioStats: {
      totalInCatalog: input.catalog.scenarios.length,
      executable: executable.length,
      selected: scenarios.length,
      direct,
      regression: scenarios.length - direct,
      missingAutomation,
      defectHeld: input.catalog.scenarios.filter((scenario) => scenario.status === 'Defect-held').length,
      staged: input.catalog.scenarios.filter((scenario) => scenario.status === 'Staged').length,
    },
    coverageGaps,
    scenarios,
    skipped,
  };
}

export function summarizeQaPlan(plan: QaProofPlan, maxMissing = 12): string {
  if (plan.automationDisabled) {
    return [
      `Post-merge readiness plan for ${plan.prUrl} (${plan.mergeCommitSha.slice(0, 12)})`,
      '',
      'Automated QA execution is disabled.',
      `Deployment workflow: ${plan.build.workflowId}`,
      'Hermes will still wait for the deployment build, update Jira, move the ticket to Ready for QA, and notify Slack.',
    ].join('\n');
  }

  const missing = plan.scenarios.filter((scenario) => scenario.automationStatus === 'missing');
  const direct = plan.scenarios.filter((scenario) => scenario.selection === 'direct');
  const missingList = missing
    .slice(0, maxMissing)
    .map((scenario) => `- ${scenario.id}: ${scenario.title}`)
    .join('\n');
  const suffix = missing.length > maxMissing ? `\n- ...and ${missing.length - maxMissing} more` : '';
  return [
    `QA proof plan for ${plan.prUrl} (${plan.mergeCommitSha.slice(0, 12)})`,
    '',
    `Executable Confluence scenarios selected: ${plan.scenarioStats.selected}`,
    `Direct validation scenarios: ${plan.scenarioStats.direct}`,
    `Regression scenarios: ${plan.scenarioStats.regression}`,
    `Defect-held skipped: ${plan.scenarioStats.defectHeld}`,
    `Staged skipped: ${plan.scenarioStats.staged}`,
    `Coverage gaps: ${plan.coverageGaps.length}`,
    `Missing automation mappings: ${plan.scenarioStats.missingAutomation}`,
    '',
    direct.length
      ? `Direct scenarios:\n${direct
          .slice(0, 12)
          .map((scenario) => `- ${scenario.id}: ${scenario.reason}`)
          .join('\n')}`
      : 'Direct scenarios: none identified; full executable catalog will run as regression.',
    missing.length ? `\nMissing Maestro mappings:\n${missingList}${suffix}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
