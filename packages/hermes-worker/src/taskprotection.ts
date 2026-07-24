/**
 * ECS task scale-in protection. While a worker is processing a job we mark its own task
 * protected so the autoscaler's scale-in never terminates it mid-job; we clear protection
 * when idle so idle workers can be scaled in. No-op outside ECS (e.g. local runs).
 */
import { ECSClient, UpdateTaskProtectionCommand } from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});
const PROTECTION_MINUTES = Math.max(2, Number(process.env.TASK_PROTECTION_EXPIRES_MINUTES ?? 30));
const RENEW_SECONDS = Math.max(30, Number(process.env.TASK_PROTECTION_RENEW_SECONDS ?? 10 * 60));

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

export async function setScaleInProtection(enabled: boolean, expiresInMinutes = 60): Promise<void> {
  const id = await taskIdentity();
  if (!id) return; // not running on ECS
  try {
    await ecs.send(
      new UpdateTaskProtectionCommand({
        cluster: id.cluster,
        tasks: [id.taskArn],
        protectionEnabled: enabled,
        ...(enabled ? { expiresInMinutes } : {}),
      })
    );
  } catch (err) {
    // Non-fatal: worst case the autoscaler could scale this task in; the SQS message would
    // then redeliver. Log and continue.
    console.error('task scale-in protection update failed:', err instanceof Error ? err.message : String(err));
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
  let renewal: Promise<void> | undefined;
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
