/**
 * ECS task scale-in protection. While a worker is processing a job we mark its own task
 * protected so the autoscaler's scale-in never terminates it mid-job; we clear protection
 * when idle so idle workers can be scaled in. No-op outside ECS (e.g. local runs).
 */
import { ECSClient, UpdateTaskProtectionCommand } from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});

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
