export const JIRA_SPRINT_FIELD_ID = 'customfield_10020';
export const JIRA_PLANNING_PROPERTY_KEY = 'donatemate.mcp.planning.v1';

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_EXCEPTION_REASON_LENGTH = 500;

export const JIRA_CREATE_PLANNING_PROPERTIES = {
  sprintId: {
    type: 'number',
    description: 'Required Jira sprint ID (from dm_jira_get_sprints) unless the user explicitly requested no sprint.',
  },
  epicKey: {
    type: 'string',
    pattern: '^[A-Za-z][A-Za-z0-9_]*-[0-9]+$',
    description: 'Required Epic issue key, e.g. "DM-2398", unless the user explicitly requested no epic.',
  },
  omitSprint: {
    type: 'boolean',
    const: true,
    description: 'Set to true only when the user explicitly requested that no sprint be assigned. Never infer this from missing context or issue type.',
  },
  omitSprintReason: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_EXCEPTION_REASON_LENGTH,
    description: 'Required with omitSprint=true: quote or faithfully summarize the user\'s explicit instruction to create the ticket without a sprint.',
  },
  omitEpic: {
    type: 'boolean',
    const: true,
    description: 'Set to true only when the user explicitly requested that no epic be assigned. Never infer this from missing context or issue type.',
  },
  omitEpicReason: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_EXCEPTION_REASON_LENGTH,
    description: 'Required with omitEpic=true: quote or faithfully summarize the user\'s explicit instruction to create the ticket without an epic.',
  },
} as const;

export const JIRA_CREATE_PLANNING_REQUIREMENTS = [
  {
    anyOf: [
      { required: ['sprintId'] },
      { required: ['omitSprint', 'omitSprintReason'] },
    ],
  },
  {
    anyOf: [
      { required: ['epicKey'] },
      // parentKey remains a compatibility alias for epicKey on non-subtasks.
      { required: ['parentKey'] },
      { required: ['omitEpic', 'omitEpicReason'] },
    ],
  },
] as const;

export interface JiraIssuePlanningAudit {
  schemaVersion: 1;
  source: 'donatemate-mcp';
  enforcement: 'sprint-and-epic-required-unless-user-exempted';
  auditId: string;
  sprint:
    | { assigned: true; id: number }
    | { assigned: false; explicitlyOmitted: true; userInstruction: string };
  epic:
    | { assigned: true; key: string }
    | { assigned: false; explicitlyOmitted: true; userInstruction: string };
}

export interface JiraIssuePlanningPlan {
  fields: Record<string, unknown>;
  sprintId?: number;
  epicKey?: string;
  sprintOmissionReason?: string;
  epicOmissionReason?: string;
  subtaskParentKey?: string;
}

function cleanString(value: unknown, maxLength = MAX_EXCEPTION_REASON_LENGTH): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeIssueKey(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const key = cleanString(value, 80).toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(key)) {
    throw new Error(`${fieldName} must be a valid Jira issue key, e.g. "DM-2398"`);
  }
  return key;
}

function isIssueType(issueType: string, expected: 'epic' | 'subtask'): boolean {
  return issueType.toLowerCase().replace(/[\s_-]/g, '') === expected;
}

function resolveOmission(
  label: 'sprint' | 'epic',
  hasAssignment: boolean,
  omitValue: unknown,
  reasonValue: unknown
): string | undefined {
  const omitName = label === 'sprint' ? 'omitSprint' : 'omitEpic';
  const reasonName = label === 'sprint' ? 'omitSprintReason' : 'omitEpicReason';
  const reason = cleanString(reasonValue);

  if (omitValue !== undefined && omitValue !== true) {
    throw new Error(`${omitName} may only be supplied as true`);
  }
  if (hasAssignment && (omitValue === true || reason)) {
    throw new Error(`Cannot both assign and explicitly omit the Jira ${label}`);
  }
  if (omitValue === true && !reason) {
    throw new Error(`${reasonName} is required when ${omitName}=true`);
  }
  if (omitValue !== true && reason) {
    throw new Error(`${reasonName} may only be supplied with ${omitName}=true`);
  }
  if (!hasAssignment && omitValue !== true) {
    const discovery = label === 'sprint'
      ? 'Use dm_jira_get_sprints to select a sprint.'
      : 'Select the appropriate Epic or ask the user for it.';
    throw new Error(
      `Jira issue creation blocked: ${label === 'sprint' ? 'sprintId' : 'epicKey'} is required. ` +
      `Only omit it when the user explicitly requested no ${label}; then pass ${omitName}=true and ` +
      `${reasonName} with that instruction. ${discovery}`
    );
  }

  return omitValue === true ? reason : undefined;
}

export function buildJiraIssuePlanningPlan(
  args: Record<string, unknown>,
  issueType: string
): JiraIssuePlanningPlan {
  const rawSprintId = args.sprintId;
  const hasSprintId = rawSprintId !== undefined && rawSprintId !== null;
  if (hasSprintId && (
    typeof rawSprintId !== 'number' ||
    !Number.isSafeInteger(rawSprintId) ||
    rawSprintId <= 0
  )) {
    throw new Error('sprintId must be a positive integer from dm_jira_get_sprints');
  }
  const sprintId = hasSprintId ? rawSprintId as number : undefined;

  const suppliedEpicKey = normalizeIssueKey(args.epicKey, 'epicKey');
  const suppliedParentKey = normalizeIssueKey(args.parentKey, 'parentKey');
  const isEpic = isIssueType(issueType, 'epic');
  const isSubtask = isIssueType(issueType, 'subtask');

  if (isEpic && sprintId !== undefined) {
    throw new Error(
      'DM Epic issues do not expose the Sprint field. The user must explicitly request no sprint and the call must use omitSprint=true with omitSprintReason.'
    );
  }
  if (isEpic && (suppliedEpicKey || suppliedParentKey)) {
    throw new Error(
      'An Epic cannot be assigned to another Epic in the DM Jira hierarchy. The user must explicitly request no epic and the call must use omitEpic=true with omitEpicReason.'
    );
  }

  let epicKey = suppliedEpicKey;
  let subtaskParentKey: string | undefined;
  if (isSubtask) {
    if (!suppliedParentKey) {
      throw new Error('parentKey is required when creating a Jira Subtask');
    }
    subtaskParentKey = suppliedParentKey;
  } else if (!isEpic && suppliedParentKey) {
    if (epicKey && epicKey !== suppliedParentKey) {
      throw new Error('epicKey and parentKey must identify the same Epic when both are provided');
    }
    epicKey = epicKey || suppliedParentKey;
  }

  const sprintOmissionReason = resolveOmission(
    'sprint',
    sprintId !== undefined,
    args.omitSprint,
    args.omitSprintReason
  );
  const epicOmissionReason = resolveOmission(
    'epic',
    epicKey !== undefined,
    args.omitEpic,
    args.omitEpicReason
  );

  const fields: Record<string, unknown> = {};
  if (sprintId !== undefined) fields[JIRA_SPRINT_FIELD_ID] = sprintId;
  if (subtaskParentKey) fields.parent = { key: subtaskParentKey };
  else if (epicKey) fields.parent = { key: epicKey };

  return {
    fields,
    ...(sprintId !== undefined ? { sprintId } : {}),
    ...(epicKey ? { epicKey } : {}),
    ...(sprintOmissionReason ? { sprintOmissionReason } : {}),
    ...(epicOmissionReason ? { epicOmissionReason } : {}),
    ...(subtaskParentKey ? { subtaskParentKey } : {}),
  };
}

export function validateSubtaskEpicInheritance(
  plan: JiraIssuePlanningPlan,
  parentIssue: unknown
): void {
  if (!plan.subtaskParentKey) return;

  const parent = parentIssue as { fields?: { parent?: { key?: unknown } } } | null;
  const inheritedEpicKey = normalizeIssueKey(parent?.fields?.parent?.key, 'parent.fields.parent.key');

  if (plan.epicKey && inheritedEpicKey !== plan.epicKey) {
    if (!inheritedEpicKey) {
      throw new Error(
        `Subtask parent ${plan.subtaskParentKey} is not assigned to an Epic; expected ${plan.epicKey}`
      );
    }
    throw new Error(
      `Subtask parent ${plan.subtaskParentKey} belongs to Epic ${inheritedEpicKey}, not ${plan.epicKey}`
    );
  }
  if (plan.epicOmissionReason && inheritedEpicKey) {
    throw new Error(
      `Cannot create the Subtask without an Epic because parent ${plan.subtaskParentKey} already belongs to ${inheritedEpicKey}`
    );
  }
}

export function buildJiraIssuePlanningAudit(
  plan: JiraIssuePlanningPlan,
  auditId: string
): JiraIssuePlanningAudit {
  return {
    schemaVersion: 1,
    source: 'donatemate-mcp',
    enforcement: 'sprint-and-epic-required-unless-user-exempted',
    auditId,
    sprint: plan.sprintId !== undefined
      ? { assigned: true, id: plan.sprintId }
      : {
          assigned: false,
          explicitlyOmitted: true,
          userInstruction: plan.sprintOmissionReason!,
        },
    epic: plan.epicKey
      ? { assigned: true, key: plan.epicKey }
      : {
          assigned: false,
          explicitlyOmitted: true,
          userInstruction: plan.epicOmissionReason!,
        },
  };
}
