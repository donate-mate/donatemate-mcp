import { describe, expect, it } from 'vitest';
import {
  JIRA_CREATE_PLANNING_PROPERTIES,
  JIRA_CREATE_PLANNING_REQUIREMENTS,
  JIRA_PLANNING_PROPERTY_KEY,
  buildJiraIssuePlanningAudit,
  buildJiraIssuePlanningPlan,
  validateSubtaskEpicInheritance,
} from './jiraIssuePlanning.js';

describe('Jira issue planning enforcement', () => {
  it('advertises fail-closed sprint and epic alternatives in the MCP schema', () => {
    expect(JIRA_CREATE_PLANNING_PROPERTIES.omitSprint.const).toBe(true);
    expect(JIRA_CREATE_PLANNING_PROPERTIES.omitEpic.const).toBe(true);
    expect(JIRA_CREATE_PLANNING_REQUIREMENTS).toEqual([
      {
        anyOf: [
          { required: ['sprintId'] },
          { required: ['omitSprint', 'omitSprintReason'] },
        ],
      },
      {
        anyOf: [
          { required: ['epicKey'] },
          { required: ['parentKey'] },
          { required: ['omitEpic', 'omitEpicReason'] },
        ],
      },
    ]);
  });

  it('sets the DM sprint custom field and Jira parent for a planned issue', () => {
    const plan = buildJiraIssuePlanningPlan({
      sprintId: 312,
      epicKey: ' dm-2398 ',
    }, 'Bug');

    expect(plan).toMatchObject({
      sprintId: 312,
      epicKey: 'DM-2398',
      fields: {
        customfield_10020: 312,
        parent: { key: 'DM-2398' },
      },
    });
    expect(buildJiraIssuePlanningAudit(plan, 'mcp_request-1')).toEqual({
      schemaVersion: 1,
      source: 'donatemate-mcp',
      enforcement: 'sprint-and-epic-required-unless-user-exempted',
      auditId: 'mcp_request-1',
      sprint: { assigned: true, id: 312 },
      epic: { assigned: true, key: 'DM-2398' },
    });
    expect(JIRA_PLANNING_PROPERTY_KEY).toBe('donatemate.mcp.planning.v1');
  });

  it('accepts parentKey as a backwards-compatible epic alias for standard issues', () => {
    expect(buildJiraIssuePlanningPlan({
      sprintId: 312,
      parentKey: 'DM-2398',
    }, 'Task')).toMatchObject({
      epicKey: 'DM-2398',
      fields: { parent: { key: 'DM-2398' } },
    });
  });

  it('allows omissions only with explicit flags and preserves the user instructions', () => {
    const plan = buildJiraIssuePlanningPlan({
      omitSprint: true,
      omitSprintReason: ' User explicitly said: keep this in the backlog. ',
      omitEpic: true,
      omitEpicReason: 'User explicitly requested a standalone ticket.',
    }, 'Task');

    expect(plan.fields).toEqual({});
    expect(buildJiraIssuePlanningAudit(plan, 'mcp_request-2')).toMatchObject({
      sprint: {
        assigned: false,
        explicitlyOmitted: true,
        userInstruction: 'User explicitly said: keep this in the backlog.',
      },
      epic: {
        assigned: false,
        explicitlyOmitted: true,
        userInstruction: 'User explicitly requested a standalone ticket.',
      },
    });
  });

  it.each([
    [{ epicKey: 'DM-2398' }, 'sprintId is required'],
    [{ sprintId: 312 }, 'epicKey is required'],
    [{ sprintId: 0, epicKey: 'DM-2398' }, 'sprintId must be a positive integer'],
    [{ sprintId: 312.5, epicKey: 'DM-2398' }, 'sprintId must be a positive integer'],
    [{ sprintId: 312, epicKey: 'not-an-issue' }, 'epicKey must be a valid Jira issue key'],
    [{ sprintId: 312, epicKey: 'DM-2398', omitSprint: true, omitSprintReason: 'No sprint' }, 'Cannot both assign and explicitly omit the Jira sprint'],
    [{ sprintId: 312, omitEpic: true }, 'omitEpicReason is required'],
    [{ sprintId: 312, omitEpicReason: 'No epic' }, 'omitEpicReason may only be supplied with omitEpic=true'],
    [{ sprintId: 312, omitEpic: false, omitEpicReason: 'No epic' }, 'omitEpic may only be supplied as true'],
    [{ sprintId: 312, epicKey: 'DM-2398', parentKey: 'DM-2400' }, 'epicKey and parentKey must identify the same Epic'],
  ])('rejects an invalid or ambiguous planning request %#', (input, message) => {
    expect(() => buildJiraIssuePlanningPlan(input, 'Task')).toThrow(message);
  });

  it('requires explicit omissions when creating an Epic in the DM hierarchy', () => {
    expect(() => buildJiraIssuePlanningPlan({
      sprintId: 312,
      omitEpic: true,
      omitEpicReason: 'The user requested a new top-level Epic.',
    }, 'Epic')).toThrow('DM Epic issues do not expose the Sprint field');

    expect(() => buildJiraIssuePlanningPlan({
      omitSprint: true,
      omitSprintReason: 'The user requested a new top-level Epic.',
      epicKey: 'DM-2398',
    }, 'Epic')).toThrow('An Epic cannot be assigned to another Epic');

    expect(buildJiraIssuePlanningPlan({
      omitSprint: true,
      omitSprintReason: 'The user explicitly requested no sprint for this Epic.',
      omitEpic: true,
      omitEpicReason: 'The user explicitly requested a new top-level Epic.',
    }, 'Epic').fields).toEqual({});
  });

  it('uses the immediate parent for a Subtask and verifies its inherited Epic', () => {
    const plan = buildJiraIssuePlanningPlan({
      sprintId: 312,
      parentKey: 'DM-4000',
      epicKey: 'DM-2398',
    }, 'Subtask');

    expect(plan).toMatchObject({
      epicKey: 'DM-2398',
      subtaskParentKey: 'DM-4000',
      fields: {
        customfield_10020: 312,
        parent: { key: 'DM-4000' },
      },
    });
    expect(() => validateSubtaskEpicInheritance(plan, {
      fields: { parent: { key: 'DM-2398' } },
    })).not.toThrow();
    expect(() => validateSubtaskEpicInheritance(plan, {
      fields: { parent: { key: 'DM-9999' } },
    })).toThrow('belongs to Epic DM-9999, not DM-2398');
    expect(() => validateSubtaskEpicInheritance(plan, {
      fields: {},
    })).toThrow('is not assigned to an Epic; expected DM-2398');
  });

  it('does not allow a no-epic Subtask beneath a parent that belongs to an Epic', () => {
    const plan = buildJiraIssuePlanningPlan({
      sprintId: 312,
      parentKey: 'DM-4000',
      omitEpic: true,
      omitEpicReason: 'The user explicitly requested no epic.',
    }, 'Sub-task');

    expect(() => validateSubtaskEpicInheritance(plan, {
      fields: { parent: { key: 'DM-2398' } },
    })).toThrow('parent DM-4000 already belongs to DM-2398');
  });
});
