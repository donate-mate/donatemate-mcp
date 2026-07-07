/**
 * --- WS5 --- Cross-PR overlap coordination.
 *
 * Detects when two open Hermes PRs in the same repo touch overlapping files so the control plane
 * can warn reviewers (and, after a merge, auto-rebase + re-validate the losing PR). All work here
 * is best-effort and fails open — it never throws into the reconcile loop.
 */
import { listActivePrWatches, type PrWatch } from './prWatch.js';
import { commentOnPullRequest, listPullRequestChangedFiles } from './github.js';

export interface PrOverlap {
  prNumber: number;
  prUrl: string;
  headBranch: string;
  baseBranch: string;
  issueKey?: string;
  sharedFiles: string[];
}

// --- WS5 --- Compare the current PR's changed files against every OTHER active Hermes watch in
// the same repo and return the ones that share at least one file.
export async function computeOverlaps(repo: string, prNumber: number, changedFiles: string[]): Promise<PrOverlap[]> {
  if (!changedFiles.length) return [];
  const mine = new Set(changedFiles);
  let peers: PrWatch[] = [];
  try {
    peers = (await listActivePrWatches()).filter((w) => w.repo === repo && w.prNumber !== prNumber);
  } catch {
    return [];
  }

  const overlaps: PrOverlap[] = [];
  for (const peer of peers) {
    try {
      const theirFiles = await listPullRequestChangedFiles(peer.repo, peer.prNumber);
      const sharedFiles = theirFiles.filter((f) => mine.has(f));
      if (sharedFiles.length) {
        overlaps.push({
          prNumber: peer.prNumber,
          prUrl: peer.prUrl,
          headBranch: peer.headBranch,
          baseBranch: peer.baseBranch,
          issueKey: peer.issueKey,
          sharedFiles,
        });
      }
    } catch {
      // A single unreadable peer must not abort overlap detection for the rest.
    }
  }
  return overlaps;
}

function overlapComment(otherPrUrl: string, sharedFiles: string[]): string {
  const files = sharedFiles.slice(0, 20).map((f) => `- \`${f}\``).join('\n');
  const more = sharedFiles.length > 20 ? `\n…and ${sharedFiles.length - 20} more` : '';
  return [
    `⚠️ **Hermes overlap warning** — this PR touches files also changed by an open Hermes PR: ${otherPrUrl}`,
    '',
    'Shared files:',
    files + more,
    '',
    'Coordinate to avoid conflicting edits — whichever merges first will trigger an auto-rebase + re-validation of the other.',
  ].join('\n');
}

// --- WS5 --- Post the overlap warning on the current PR and on each overlapping PR. Returns the
// synthetic signal ids that were announced so the caller can persist them for dedupe.
export async function announceOverlaps(
  repo: string,
  prNumber: number,
  prUrl: string,
  overlaps: PrOverlap[]
): Promise<string[]> {
  const announced: string[] = [];
  for (const overlap of overlaps) {
    try {
      await commentOnPullRequest(repo, prNumber, overlapComment(overlap.prUrl, overlap.sharedFiles));
      await commentOnPullRequest(repo, overlap.prNumber, overlapComment(prUrl, overlap.sharedFiles));
      announced.push(`overlap:${overlap.prNumber}`);
    } catch {
      // Fail open per overlap.
    }
  }
  return announced;
}
