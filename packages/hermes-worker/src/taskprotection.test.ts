import { ECSClient } from '@aws-sdk/client-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startScaleInProtectionRenewal,
  TaskProtectionUnavailableError,
  taskProtectionConfig,
} from './taskprotection.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ECS_CONTAINER_METADATA_URI_V4;
});

describe('taskProtectionConfig', () => {
  it('uses a lease longer than the two-hour workflow waits and renews every ten minutes', () => {
    expect(taskProtectionConfig({})).toEqual({
      protectionMinutes: 165,
      renewSeconds: 600,
    });
  });

  it('bounds invalid overrides and always renews before half of the lease', () => {
    expect(
      taskProtectionConfig({
        TASK_PROTECTION_EXPIRES_MINUTES: '5',
        TASK_PROTECTION_RENEW_SECONDS: '9999',
      })
    ).toEqual({
      protectionMinutes: 5,
      renewSeconds: 150,
    });

    expect(
      taskProtectionConfig({
        TASK_PROTECTION_EXPIRES_MINUTES: 'not-a-number',
        TASK_PROTECTION_RENEW_SECONDS: 'not-a-number',
      })
    ).toEqual({
      protectionMinutes: 165,
      renewSeconds: 600,
    });
  });

  it('refuses work when ECS has already selected the task for draining', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://task-metadata';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ Cluster: 'cluster', TaskARN: 'task' }),
    } as Response);
    vi.spyOn(ECSClient.prototype, 'send').mockResolvedValue({
      failures: [{ reason: 'DEPLOYMENT_BLOCKED' }],
    } as never);

    await expect(startScaleInProtectionRenewal()).rejects.toBeInstanceOf(
      TaskProtectionUnavailableError
    );
  });
});
