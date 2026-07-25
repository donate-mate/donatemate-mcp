import { describe, expect, it } from 'vitest';
import { taskProtectionConfig } from './taskprotection.js';

describe('taskProtectionConfig', () => {
  it('uses a two-hour initial lease and renews every ten minutes by default', () => {
    expect(taskProtectionConfig({})).toEqual({
      protectionMinutes: 120,
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
      protectionMinutes: 120,
      renewSeconds: 600,
    });
  });
});
