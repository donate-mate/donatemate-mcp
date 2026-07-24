import type { JiraCommentEvent } from './jira.js';

export interface CommentClaimHandle {
  markerKey: string;
  token: string;
}

export interface CommentProcessorDeps<TClaim extends CommentClaimHandle = CommentClaimHandle> {
  tryClaim: (event: JiraCommentEvent) => Promise<TClaim | undefined>;
  process: (event: JiraCommentEvent) => Promise<void>;
  complete: (claim: TClaim) => Promise<void>;
  release: (claim: TClaim) => Promise<void>;
}

export async function processJiraCommentEvent<TClaim extends CommentClaimHandle>(
  event: JiraCommentEvent,
  deps: CommentProcessorDeps<TClaim>
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
        `[jira-comments] failed to release ${claim.markerKey}: ${
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        }`
      );
    }
    throw err;
  }
}

export interface CommentReconcileResult {
  discovered: number;
  processed: number;
  skipped: number;
  failed: number;
}

/** Preserve comment order for one issue so plan refinements cannot overtake a preceding message. */
export async function reconcileJiraCommentEvents<TClaim extends CommentClaimHandle>(
  events: JiraCommentEvent[],
  deps: CommentProcessorDeps<TClaim>,
  onError: (event: JiraCommentEvent, err: unknown) => void = () => undefined
): Promise<CommentReconcileResult> {
  const result: CommentReconcileResult = { discovered: events.length, processed: 0, skipped: 0, failed: 0 };
  for (const event of events) {
    try {
      if (await processJiraCommentEvent(event, deps)) result.processed++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      onError(event, err);
    }
  }
  return result;
}
