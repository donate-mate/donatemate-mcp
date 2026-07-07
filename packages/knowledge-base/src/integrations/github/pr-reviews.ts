/**
 * Hermes PR Review Ingestion
 *
 * Nightly ingestion of human code-review feedback on Hermes-authored PRs.
 * Each review comment becomes a `comment` chunk in the knowledge base so
 * future Hermes jobs can surface "previously flagged patterns".
 *
 * Hermes PRs are identified by their HEAD BRANCH PREFIX (`hermes/`), which is
 * the most reliable signal (the PR author is the GitHub App bot identity).
 */

import { Octokit } from '@octokit/rest';
import { createHash } from 'crypto';
import type { ContentChunk } from '../../types/index.js';
import type { DatabaseService } from '../../services/database.js';
import type { EmbedderService } from '../../services/embedder.js';

export interface IngestHermesPrReviewsOptions {
  /** Knowledge-base database service (already constructed/initialized). */
  db: DatabaseService;
  /** Embedder service for generating vector embeddings. */
  embedder: EmbedderService;
  /** Repository in `owner/name` form, e.g. `donate-mate/donatemate`. */
  repo: string;
  /** Pre-built Octokit client. If omitted, one is created from `token`. */
  octokit?: Octokit;
  /** GitHub token (PAT / App installation token). Used only if `octokit` is not provided. */
  token?: string;
  /** Only consider PRs updated within this many days (default: 90). */
  sinceDays?: number;
  /** Head-branch prefix that marks a Hermes PR (default: `hermes/`). */
  hermesBranchPrefix?: string;
  /**
   * Logins (case-insensitive) whose comments should be treated as the bot's
   * own and skipped. Any login matching `hermes` or ending in `[bot]`, or a
   * user of type `Bot`, is skipped automatically.
   */
  botLogins?: string[];
}

export interface IngestHermesPrReviewsResult {
  ingested: number;
}

type Severity = 'blocking' | 'advisory';

/**
 * Heuristically parse a severity label from a review comment body.
 * - "blocking" / "must" / "required" => 'blocking'
 * - "nit" / "consider" / "suggestion" / "optional" => 'advisory'
 * - otherwise undefined
 */
export function parseSeverity(body: string): Severity | undefined {
  const text = (body || '').toLowerCase();
  if (/\b(blocking|blocker|must|must-fix|required|critical)\b/.test(text)) {
    return 'blocking';
  }
  if (/\b(nit|nitpick|consider|suggestion|optional|advisory|minor)\b/.test(text)) {
    return 'advisory';
  }
  return undefined;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function chunkId(externalId: string, contentHash: string): string {
  return `github:${externalId}:${contentHash.substring(0, 8)}`;
}

function isBotAuthor(
  login: string | undefined,
  type: string | undefined,
  botLogins: string[]
): boolean {
  if (!login) return true; // skip ghost/unknown authors
  const lower = login.toLowerCase();
  if (type === 'Bot') return true;
  if (lower.includes('hermes')) return true;
  if (lower.endsWith('[bot]')) return true;
  return botLogins.some((b) => b.toLowerCase() === lower);
}

/**
 * Ingest every human code-review comment on Hermes-authored PRs into the
 * knowledge base. Fails open per-PR (a fetch/embed error on one PR is logged
 * and skipped rather than aborting the whole run).
 */
export async function ingestHermesPrReviewComments(
  opts: IngestHermesPrReviewsOptions
): Promise<IngestHermesPrReviewsResult> {
  const { db, embedder, repo } = opts;
  const sinceDays = opts.sinceDays ?? 90;
  const branchPrefix = opts.hermesBranchPrefix ?? 'hermes/';
  const botLogins = opts.botLogins ?? [];

  const slash = repo.indexOf('/');
  if (slash <= 0) {
    throw new Error(`Invalid repo "${repo}" (expected "owner/name")`);
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);

  const octokit = opts.octokit ?? new Octokit({ auth: opts.token });
  const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let ingested = 0;

  // -------------------------------------------------------------------------
  // 1. Find Hermes PRs (head-branch prefix), most recently updated first.
  // -------------------------------------------------------------------------
  const hermesPrNumbers: number[] = [];
  for (let page = 1; page <= 20; page++) {
    let prs;
    try {
      const resp = await octokit.pulls.list({
        owner,
        repo: name,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      });
      prs = resp.data;
    } catch (err) {
      console.warn('[pr-reviews] Failed to list PRs', {
        repo,
        page,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    if (prs.length === 0) break;

    let allOlderThanCutoff = true;
    for (const pr of prs) {
      const updatedMs = pr.updated_at ? new Date(pr.updated_at).getTime() : Date.now();
      if (updatedMs >= cutoffMs) {
        allOlderThanCutoff = false;
        if (pr.head?.ref?.startsWith(branchPrefix)) {
          hermesPrNumbers.push(pr.number);
        }
      }
    }

    // The list is sorted by updated desc, so once an entire page predates the
    // cutoff we can stop paginating.
    if (allOlderThanCutoff) break;
    if (prs.length < 100) break;
  }

  console.info('[pr-reviews] Found Hermes PRs', {
    repo,
    count: hermesPrNumbers.length,
  });

  // -------------------------------------------------------------------------
  // 2. For each Hermes PR, ingest review + issue comments (fail-open per PR).
  // -------------------------------------------------------------------------
  for (const prNumber of hermesPrNumbers) {
    try {
      const chunks: ContentChunk[] = [];

      // Inline (diff) review comments — carry path + line.
      const reviewComments = await octokit.paginate(octokit.pulls.listReviewComments, {
        owner,
        repo: name,
        pull_number: prNumber,
        per_page: 100,
      });

      for (const c of reviewComments) {
        if (isBotAuthor(c.user?.login, c.user?.type, botLogins)) continue;
        const body = c.body ?? '';
        if (!body.trim()) continue;

        const path = c.path ?? undefined;
        const line = c.line ?? c.original_line ?? undefined;
        const chunk = buildCommentChunk({
          repo,
          owner,
          name,
          pr: prNumber,
          commentId: c.id,
          kind: 'review-comment',
          body,
          path,
          line,
          authorName: c.user?.login,
          url: c.html_url,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        });
        chunks.push(chunk);
      }

      // Issue-style PR comments — general discussion (no path/line).
      const issueComments = await octokit.paginate(octokit.issues.listComments, {
        owner,
        repo: name,
        issue_number: prNumber,
        per_page: 100,
      });

      for (const c of issueComments) {
        if (isBotAuthor(c.user?.login, c.user?.type, botLogins)) continue;
        const body = c.body ?? '';
        if (!body.trim()) continue;

        const chunk = buildCommentChunk({
          repo,
          owner,
          name,
          pr: prNumber,
          commentId: c.id,
          kind: 'comment',
          body,
          path: undefined,
          line: undefined,
          authorName: c.user?.login,
          url: c.html_url,
          createdAt: c.created_at,
          updatedAt: c.updated_at ?? c.created_at,
        });
        chunks.push(chunk);
      }

      if (chunks.length === 0) continue;

      const embeddings = await embedder.embedBatch(chunks.map((ch) => ch.content));
      await db.upsertChunks(
        chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] }))
      );

      ingested += chunks.length;
      console.info('[pr-reviews] Ingested PR review comments', {
        repo,
        pr: prNumber,
        comments: chunks.length,
      });
    } catch (err) {
      console.warn('[pr-reviews] Failed to ingest PR (skipping)', {
        repo,
        pr: prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail open: continue with the next PR.
    }
  }

  console.info('[pr-reviews] Ingestion complete', { repo, ingested });
  return { ingested };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildCommentChunkArgs {
  repo: string;
  owner: string;
  name: string;
  pr: number;
  commentId: number;
  kind: 'review-comment' | 'comment';
  body: string;
  path?: string;
  line?: number;
  authorName?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

function buildCommentChunk(args: BuildCommentChunkArgs): ContentChunk {
  const { repo, pr, commentId, kind, body, path, line, authorName, url } = args;

  const severity = parseSeverity(body);
  const externalId = `${repo}#${pr}#${kind}-${commentId}`;
  const contentHash = hashContent(body);

  const location = path ? ` ${path}${line != null ? `:${line}` : ''}` : '';
  const title =
    kind === 'review-comment'
      ? `Review on PR #${pr}${location}`
      : `Comment on PR #${pr}`;

  const createdAt = args.createdAt ? new Date(args.createdAt) : new Date();
  const updatedAt = args.updatedAt ? new Date(args.updatedAt) : createdAt;

  return {
    id: chunkId(externalId, contentHash),
    externalId,
    sourceType: 'github',
    sourceUrl: url ?? `https://github.com/${repo}/pull/${pr}`,
    title,
    content: body,
    contentType: 'markdown',
    contentHash,
    chunkType: 'comment',
    projectKey: repo,
    filePath: path,
    startLine: line,
    endLine: line,
    authorName: authorName ?? undefined,
    createdAt,
    updatedAt,
    metadata: {
      pr,
      path: path ?? null,
      line: line ?? null,
      author: authorName ?? null,
      severity: severity ?? null,
    },
  };
}
