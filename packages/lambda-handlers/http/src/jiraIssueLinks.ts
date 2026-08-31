export interface JiraIssueLinkRequest {
  sourceIssueKey: string;
  targetIssueKey: string;
  linkType: string;
  payload: {
    type: { name: string };
    outwardIssue: { key: string };
    inwardIssue: { key: string };
  };
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveIssueKey(
  args: Record<string, unknown>,
  preferredName: 'sourceIssueKey' | 'targetIssueKey',
  legacyName: 'outwardIssueKey' | 'inwardIssueKey'
): string {
  const preferred = cleanString(args[preferredName]);
  const legacy = cleanString(args[legacyName]);

  if (preferred && legacy && preferred.toUpperCase() !== legacy.toUpperCase()) {
    throw new Error(`${preferredName} and ${legacyName} must identify the same issue when both are provided`);
  }

  return preferred || legacy;
}

export function buildJiraIssueLinkRequest(args: Record<string, unknown>): JiraIssueLinkRequest {
  const sourceIssueKey = resolveIssueKey(args, 'sourceIssueKey', 'outwardIssueKey');
  const targetIssueKey = resolveIssueKey(args, 'targetIssueKey', 'inwardIssueKey');
  const linkType = args.linkType === undefined ? 'Blocks' : cleanString(args.linkType);

  if (!sourceIssueKey || !targetIssueKey) {
    throw new Error(
      'sourceIssueKey and targetIssueKey are required (legacy outwardIssueKey and inwardIssueKey are also accepted)'
    );
  }
  if (sourceIssueKey.toUpperCase() === targetIssueKey.toUpperCase()) {
    throw new Error('sourceIssueKey and targetIssueKey must identify different issues');
  }
  if (!linkType) throw new Error('linkType must not be empty');

  return {
    sourceIssueKey,
    targetIssueKey,
    linkType,
    payload: {
      type: { name: linkType },
      outwardIssue: { key: sourceIssueKey },
      inwardIssue: { key: targetIssueKey },
    },
  };
}
