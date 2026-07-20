import type { JiraAssignmentEvent } from './jira.js';

export interface AssignmentClaimHandle {
  markerKey: string;
  token: string;
}

export interface AssignmentProcessorDeps<TClaim extends AssignmentClaimHandle = AssignmentClaimHandle> {
  tryClaim: (event: JiraAssignmentEvent) => Promise<TClaim | undefined>;
  process: (event: JiraAssignmentEvent) => Promise<void>;
  complete: (claim: TClaim) => Promise<void>;
  release: (claim: TClaim) => Promise<void>;
}

/** Process one Jira assignee-change event once across all control-plane replicas. */
export async function processJiraAssignmentEvent<TClaim extends AssignmentClaimHandle>(
  event: JiraAssignmentEvent,
  deps: AssignmentProcessorDeps<TClaim>
): Promise<boolean> {
  const claim = await deps.tryClaim(event);
  if (!claim) return false;

  try {
    await deps.process(event);
    await deps.complete(claim);
    return true;
  } catch (err) {
    try {
      await deps.release(claim);
    } catch (releaseErr) {
      console.warn(
        `[jira-reconcile] failed to release ${claim.markerKey}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`
      );
    }
    throw err;
  }
}

export interface ReconcileResult {
  discovered: number;
  processed: number;
  skipped: number;
  failed: number;
}

/** A per-event failure is isolated so one malformed/inaccessible ticket cannot starve the batch. */
export async function reconcileJiraAssignmentEvents<TClaim extends AssignmentClaimHandle>(
  events: JiraAssignmentEvent[],
  deps: AssignmentProcessorDeps<TClaim>,
  onError: (event: JiraAssignmentEvent, err: unknown) => void = () => undefined
): Promise<ReconcileResult> {
  const result: ReconcileResult = { discovered: events.length, processed: 0, skipped: 0, failed: 0 };
  for (const event of events) {
    try {
      if (await processJiraAssignmentEvent(event, deps)) result.processed++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      onError(event, err);
    }
  }
  return result;
}
