/**
 * ECS task scale-in protection. While a worker is processing a job we mark its own task
 * protected so the autoscaler's scale-in never terminates it mid-job; we clear protection
 * when idle so idle workers can be scaled in. No-op outside ECS (e.g. local runs).
 */
import { ECSClient, UpdateTaskProtectionCommand } from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});
const DEFAULT_PROTECTION_MINUTES = 120;
const DEFAULT_RENEW_SECONDS = 10 * 60;

export function taskProtectionConfig(env: NodeJS.ProcessEnv = process.env): {
  protectionMinutes: number;
  renewSeconds: number;
} {
  const configuredMinutes = Number(env.TASK_PROTECTION_EXPIRES_MINUTES);
  const protectionMinutes = Number.isFinite(configuredMinutes)
    ? Math.min(2_880, Math.max(2, Math.floor(configuredMinutes)))
    : DEFAULT_PROTECTION_MINUTES;
  const configuredRenewSeconds = Number(env.TASK_PROTECTION_RENEW_SECONDS);
  const requestedRenewSeconds = Number.isFinite(configuredRenewSeconds)
    ? Math.max(30, Math.floor(configuredRenewSeconds))
    : DEFAULT_RENEW_SECONDS;

  // Always attempt renewal well before expiry, even if an invalid deployment override is supplied.
  const renewSeconds = Math.min(
    requestedRenewSeconds,
    Math.max(30, Math.floor((protectionMinutes * 60) / 2))
  );
  return { protectionMinutes, renewSeconds };
}

const { protectionMinutes: PROTECTION_MINUTES, renewSeconds: RENEW_SECONDS } =
  taskProtectionConfig();

async function taskIdentity(): Promise<{ cluster: string; taskArn: string } | null> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/task`);
    const meta = (await res.json()) as { Cluster?: string; TaskARN?: string };
    if (!meta.Cluster || !meta.TaskARN) return null;
    return { cluster: meta.Cluster, taskArn: meta.TaskARN };
  } catch {
    return null;
  }
}

export async function setScaleInProtection(
  enabled: boolean,
  expiresInMinutes = DEFAULT_PROTECTION_MINUTES
): Promise<boolean> {
  const id = await taskIdentity();
  if (!id) return true; // not running on ECS
  try {
    const result = await ecs.send(
      new UpdateTaskProtectionCommand({
        cluster: id.cluster,
        tasks: [id.taskArn],
        protectionEnabled: enabled,
        ...(enabled ? { expiresInMinutes } : {}),
      })
    );
    if (result.failures?.length) {
      const failures = result.failures
        .map(
          (failure) =>
            `${failure.reason ?? 'UNKNOWN'}${failure.detail ? ` (${failure.detail})` : ''}`
        )
        .join('; ');
      // UpdateTaskProtection reports per-task failures in a successful API response. In
      // particular, DEPLOYMENT_BLOCKED is not thrown, so ignoring this array silently lets the
      // original protection lease expire during a rollout.
      console.error(`task scale-in protection update rejected: ${failures}`);
      return false;
    }
    return true;
  } catch (err) {
    // Non-fatal: worst case the autoscaler could scale this task in; the SQS message would
    // then redeliver. Log and continue.
    console.error('task scale-in protection update failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Keep task protection alive for the entire job instead of relying on a one-shot 60-minute lease.
 * The shorter renewable lease also releases reasonably quickly if the process is killed before it
 * can explicitly disable protection.
 */
export async function startScaleInProtectionRenewal(): Promise<() => Promise<void>> {
  await setScaleInProtection(true, PROTECTION_MINUTES);
  let stopped = false;
  let renewal: Promise<boolean> | undefined;
  const timer = setInterval(() => {
    if (stopped || renewal) return;
    renewal = setScaleInProtection(true, PROTECTION_MINUTES).finally(() => {
      renewal = undefined;
    });
  }, RENEW_SECONDS * 1000);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await renewal;
    await setScaleInProtection(false);
  };
}
