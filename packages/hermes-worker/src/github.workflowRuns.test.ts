process.env.AWS_REGION ??= 'us-east-2';

import { describe, expect, it, vi } from 'vitest';
import { latestSupersedingWorkflowRunForCommit, waitForWorkflowRunConclusion } from './github.js';

describe('latestSupersedingWorkflowRunForCommit', () => {
  it('selects the newest workflow run whose head contains the cancelled deployment commit', async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route.includes('/actions/workflows/')) {
        return {
          data: {
            workflow_runs: [
              {
                id: 30,
                name: 'Deploy to Staging',
                status: 'in_progress',
                conclusion: null,
                html_url: 'https://github.com/donate-mate/donatemate/actions/runs/30',
                head_sha: 'diverged-head',
                created_at: '2026-07-25T18:44:00Z',
              },
              {
                id: 20,
                name: 'Deploy to Staging',
                status: 'in_progress',
                conclusion: null,
                html_url: 'https://github.com/donate-mate/donatemate/actions/runs/20',
                head_sha: 'descendant-head',
                created_at: '2026-07-25T18:43:00Z',
              },
            ],
          },
        };
      }

      expect(route).toContain('/compare/');
      return {
        data: {
          status: String(input.basehead).endsWith('diverged-head') ? 'diverged' : 'ahead',
        },
      };
    });

    const run = await latestSupersedingWorkflowRunForCommit(
      { request } as any,
      'donate-mate/donatemate',
      'deploy-staging.yml',
      'cancelled-head',
      'main',
      '2026-07-25T18:40:00Z'
    );

    expect(run).toMatchObject({
      id: 20,
      status: 'in_progress',
      headSha: 'descendant-head',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('ignores older workflow runs before the cancelled deployment', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 10,
            status: 'completed',
            conclusion: 'success',
            head_sha: 'older-head',
            created_at: '2026-07-25T18:39:59Z',
          },
        ],
      },
    });

    const run = await latestSupersedingWorkflowRunForCommit(
      { request } as any,
      'donate-mate/donatemate',
      'deploy-staging.yml',
      'cancelled-head',
      'main',
      '2026-07-25T18:40:00Z'
    );

    expect(run).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('follows a successful descendant deployment after the exact-head run is cancelled', async () => {
    const request = vi.fn(async (route: string) => {
      if (route.includes('/actions/workflows/')) {
        return {
          data: {
            workflow_runs: [
              {
                id: 20,
                name: 'Deploy to Staging',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/donate-mate/donatemate/actions/runs/20',
                head_sha: 'descendant-head',
                created_at: '2026-07-25T18:43:00Z',
              },
              {
                id: 10,
                name: 'Deploy to Staging',
                status: 'completed',
                conclusion: 'cancelled',
                html_url: 'https://github.com/donate-mate/donatemate/actions/runs/10',
                head_sha: 'cancelled-head',
                created_at: '2026-07-25T18:40:00Z',
              },
            ],
          },
        };
      }
      return { data: { status: 'ahead' } };
    });

    const run = await waitForWorkflowRunConclusion({
      octokit: { request } as any,
      repo: 'donate-mate/donatemate',
      workflowId: 'deploy-staging.yml',
      headSha: 'cancelled-head',
      branch: 'main',
      timeoutSeconds: 1,
      pollSeconds: 0,
      followSupersedingRuns: true,
    });

    expect(run).toMatchObject({
      id: 20,
      conclusion: 'success',
      headSha: 'descendant-head',
    });
  });
});
