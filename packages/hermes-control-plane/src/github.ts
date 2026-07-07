/**
 * GitHub App helpers for PR monitoring. The control plane uses these to verify GitHub webhooks,
 * inspect CI/check state, and read unresolved review threads without invoking the coding agent.
 */
import crypto from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getSecretJson } from './secrets.js';
import type { PrSignal, PrWatch } from './prWatch.js';

const SECRET_GITHUB_APP = process.env.SECRET_GITHUB_APP!;

export interface GitHubAuth {
  token: string;
  octokit: Octokit;
}

export interface PrSnapshot {
  repo: string;
  prNumber: number;
  prUrl: string;
  headBranch: string;
  headSha: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  ciState: 'passing' | 'failing' | 'pending' | 'unknown';
  mergeable?: boolean | null;
  mergeableState?: string;
  baseBranch: string;
  baseSha: string;
  mergeCommitSha?: string | null;
  signals: PrSignal[];
}

export interface WorkflowRunSummary {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  htmlUrl?: string | null;
  headSha?: string;
  createdAt?: string | null;
}

export async function verifyGitHubSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<boolean> {
  const { webhookSecret, sharedSecret } = await getSecretJson(SECRET_GITHUB_APP);
  const secret = webhookSecret || sharedSecret;
  if (!secret) return false;

  const sig = String(headers['x-hub-signature-256'] ?? '');
  if (!sig.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export async function getInstallationAuth(repoFullName: string): Promise<GitHubAuth> {
  const { appId, installationId, privateKey } = await getSecretJson(SECRET_GITHUB_APP);
  if (!appId || !installationId || !privateKey) {
    throw new Error('GitHub App credentials not configured in Secrets Manager');
  }
  const repoName = repoFullName.split('/')[1];
  const auth = createAppAuth({ appId, installationId, privateKey });
  const { token } = await auth({
    type: 'installation',
    repositoryNames: repoName ? [repoName] : undefined,
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
      actions: 'read',
      metadata: 'read',
    },
  });
  return { token, octokit: new Octokit({ auth: token }) };
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo full name: ${repo}`);
  return { owner, name };
}

async function ensureRepositoryLabel(octokit: Octokit, repo: string, label: string): Promise<void> {
  const { owner, name } = splitRepo(repo);
  const params = { owner, repo: name, name: label };
  try {
    await octokit.issues.getLabel(params);
  } catch (err: any) {
    if (err?.status !== 404) throw err;
    await octokit.issues
      .createLabel({
        ...params,
        color: '0e8a16',
        description: 'Deploy this frontend PR to the dev test build.',
      })
      .catch((createErr: any) => {
        // Concurrent reconcile tasks may race to create the same repo label.
        if (createErr?.status !== 422) throw createErr;
      });
  }
}

export async function ensurePullRequestLabels(repo: string, pullNumber: number, labels: string[]): Promise<void> {
  const uniqueLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (!uniqueLabels.length) return;

  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  await Promise.all(uniqueLabels.map((label) => ensureRepositoryLabel(octokit, repo, label)));
  await octokit.issues.addLabels({ owner, repo: name, issue_number: pullNumber, labels: uniqueLabels });
}

export async function listPullRequestChangedFiles(repo: string, pullNumber: number): Promise<string[]> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  const files: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await octokit.pulls.listFiles({ owner, repo: name, pull_number: pullNumber, per_page: 100, page });
    files.push(...res.data.map((file) => file.filename));
    if (res.data.length < 100) break;
  }
  return files;
}

// --- WS5 --- Post a comment on a PR (best-effort; never throws into the caller). Uses the
// issues.createComment endpoint since a PR is an issue for comment purposes.
export async function commentOnPullRequest(repo: string, prNumber: number, body: string): Promise<boolean> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    await octokit.issues.createComment({ owner, repo: name, issue_number: prNumber, body });
    return true;
  } catch (err) {
    console.warn(`[github] comment on ${repo}#${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// --- WS5 --- Rebase a PR branch onto its base by merging the base branch into the head branch
// (creates a merge commit that updates the PR branch). Best-effort; reports conflicts instead of
// throwing so the caller can fall back to a follow-up job.
export async function rebasePullRequestBranch(
  repo: string,
  headBranch: string,
  baseBranch: string
): Promise<{ ok: boolean; conflict?: boolean }> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    await octokit.repos.merge({
      owner,
      repo: name,
      base: headBranch,
      head: baseBranch,
      commit_message: `Merge ${baseBranch} into ${headBranch} (Hermes auto-rebase after overlapping merge)`,
    });
    return { ok: true };
  } catch (err: any) {
    if (err?.status === 409) return { ok: false, conflict: true };
    console.warn(`[github] rebase ${repo} ${headBranch}<-${baseBranch} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

// --- WS5 --- Concatenate a PR's body and its issue comments into a single searchable blob for
// readiness gates (checklist / evidence). Best-effort — returns '' on any failure.
export async function collectPrBodyAndComments(repo: string, prNumber: number): Promise<string> {
  try {
    const { octokit } = await getInstallationAuth(repo);
    const { owner, name } = splitRepo(repo);
    const pr = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber }).then((r) => r.data);
    const parts: string[] = [String(pr.body ?? '')];
    for (let page = 1; page <= 5; page++) {
      const res = await octokit.issues.listComments({ owner, repo: name, issue_number: prNumber, per_page: 100, page });
      parts.push(...res.data.map((c) => String(c.body ?? '')));
      if (res.data.length < 100) break;
    }
    return parts.filter(Boolean).join('\n\n');
  } catch (err) {
    console.warn(`[github] collect PR body/comments for ${repo}#${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

export async function listRepositoryPaths(repo: string, ref: string): Promise<string[]> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  const res = await octokit.git.getTree({ owner, repo: name, tree_sha: ref, recursive: 'true' });
  return (res.data.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => entry.path!)
    .sort();
}

function compactText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function checkRunSignals(octokit: Octokit, repo: string, headSha: string): Promise<{ ciState: PrSnapshot['ciState']; signals: PrSignal[] }> {
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo: name,
    ref: headSha,
    per_page: 100,
  });
  const runs = res.data.check_runs ?? [];
  if (!runs.length) return { ciState: 'unknown', signals: [] };

  const failing = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(String(r.conclusion ?? '')));
  const pending = runs.some((r) => r.status !== 'completed');
  const signals: PrSignal[] = [];
  for (const run of failing.slice(0, 8)) {
    const annotations = await octokit
      .request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
        owner,
        repo: name,
        check_run_id: run.id,
        per_page: 10,
      })
      .then((r) => r.data)
      .catch(() => []);
    const annotationText = annotations
      .slice(0, 5)
      .map((a) => `  - ${a.path}:${a.start_line ?? '?'} ${compactText(a.message, 240)}`)
      .join('\n');
    signals.push({
      id: `ci:${headSha}:check:${run.id}:${run.conclusion}`,
      kind: 'ci_failed',
      headSha,
      summary: `${run.name} concluded ${run.conclusion}`,
      details: annotationText || compactText(run.output?.summary || run.output?.text || run.html_url, 900),
      url: run.html_url ?? undefined,
      createdAt: new Date().toISOString(),
    });
  }

  return { ciState: failing.length ? 'failing' : pending ? 'pending' : 'passing', signals };
}

function workflowCheckHints(workflowId: string): string[] {
  const raw = String(workflowId || '').toLowerCase();
  const base = raw
    .split('/')
    .pop()!
    .replace(/\.(ya?ml)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const hints = new Set<string>([raw, base].filter(Boolean));
  if (raw === '212167110' || raw.includes('staging')) {
    hints.add('staging build');
    hints.add('build');
  }
  if (raw === '208630294' || raw.includes('deploy')) {
    hints.add('deploy to staging');
    hints.add('deploy');
  }
  return [...hints].filter(Boolean);
}

export async function latestWorkflowSignalForCommit(repo: string, workflowId: string, headSha: string, branch?: string): Promise<WorkflowRunSummary | null> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
      owner,
      repo: name,
      workflow_id: workflowId,
      branch,
      per_page: 50,
    });
    const run = ((res.data.workflow_runs ?? []) as any[]).find((candidate) => candidate.head_sha === headSha);
    if (run) {
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        headSha: run.head_sha,
        createdAt: run.created_at,
      };
    }
  } catch {
    // Some scoped GitHub App tokens can read checks but not resolve the workflow id.
  }

  const checkRes = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner,
    repo: name,
    ref: headSha,
    per_page: 100,
  });
  const actionRuns = ((checkRes.data.check_runs ?? []) as any[]).filter((run) =>
    String(run.details_url ?? run.html_url ?? '').includes('/actions/runs/')
  );
  if (!actionRuns.length) return null;

  const hints = workflowCheckHints(workflowId);
  const matching = actionRuns.filter((run) => {
    const runName = String(run.name ?? '').toLowerCase();
    return hints.some((hint) => runName.includes(hint) || hint.includes(runName));
  });
  const candidates = matching.length ? matching : actionRuns.length === 1 ? actionRuns : [];
  if (!candidates.length) return null;
  const match = candidates.sort((a, b) => Date.parse(b.started_at ?? b.created_at ?? '') - Date.parse(a.started_at ?? a.created_at ?? ''))[0];
  return {
    id: match.id,
    name: match.name,
    status: match.status,
    conclusion: match.conclusion,
    htmlUrl: match.details_url ?? match.html_url,
    headSha,
    createdAt: match.started_at ?? match.created_at,
  };
}

async function commitContainsAncestor(octokit: Octokit, repo: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  if (!ancestorSha || !descendantSha) return false;
  if (ancestorSha === descendantSha) return true;
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo: name,
    basehead: `${ancestorSha}...${descendantSha}`,
  });
  return Number(res.data.behind_by ?? 0) === 0 && ['ahead', 'identical'].includes(String(res.data.status ?? ''));
}

export async function latestSuccessfulWorkflowSignalContainingCommit(
  repo: string,
  workflowId: string,
  ancestorSha: string,
  branch?: string
): Promise<WorkflowRunSummary | null> {
  const { octokit } = await getInstallationAuth(repo);
  const { owner, name } = splitRepo(repo);
  const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner,
    repo: name,
    workflow_id: workflowId,
    branch,
    status: 'success',
    per_page: 50,
  });

  for (const run of (res.data.workflow_runs ?? []) as any[]) {
    const headSha = String(run.head_sha ?? '');
    if (!headSha || run.status !== 'completed' || run.conclusion !== 'success') continue;
    const contains = await commitContainsAncestor(octokit, repo, ancestorSha, headSha).catch(() => false);
    if (!contains) continue;
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
      headSha,
      createdAt: run.created_at,
    };
  }
  return null;
}

async function reviewThreadSignals(token: string, repo: string, prNumber: number): Promise<PrSignal[]> {
  const { owner, name } = splitRepo(repo);
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 50) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 20) {
                nodes {
                  id
                  body
                  url
                  createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, number: prNumber } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return threads
    .filter((t: any) => !t.isResolved && !t.isOutdated)
    .map((t: any) => {
      const comments = t.comments?.nodes ?? [];
      const last = comments[comments.length - 1] ?? {};
      const body = comments
        .map((c: any) => `${c.author?.login ?? 'reviewer'}: ${compactText(c.body, 500)}`)
        .join('\n');
      return {
        id: `review:${t.id}:${last.id ?? 'none'}`,
        kind: 'review_feedback',
        summary: `Unresolved review thread on ${t.path ?? 'unknown file'}${t.line ? `:${t.line}` : ''}`,
        details: body,
        url: last.url,
        createdAt: last.createdAt ?? new Date().toISOString(),
      } as PrSignal;
    });
}

async function reviewDecisionSignals(token: string, repo: string, prNumber: number): Promise<PrSignal[]> {
  const { owner, name } = splitRepo(repo);
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewDecision
          reviews(last: 20) {
            nodes {
              databaseId
              state
              body
              url
              submittedAt
              updatedAt
              author { login }
            }
          }
        }
      }
    }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, number: prNumber } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = (await res.json()) as any;
  const pr = data.data?.repository?.pullRequest;
  if (String(pr?.reviewDecision ?? '').toUpperCase() !== 'CHANGES_REQUESTED') return [];

  const reviews = (pr.reviews?.nodes ?? []) as any[];
  return reviews
    .filter((review) => String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED')
    .map((review) => {
      const createdAt = review.submittedAt ?? review.updatedAt ?? new Date().toISOString();
      const reviewId = review.databaseId ?? review.id ?? createdAt;
      return {
        id: `review-state:${reviewId}:${createdAt}`,
        kind: 'review_feedback',
        summary: `Review requested changes by ${review.author?.login ?? 'reviewer'}`,
        details: compactText(review.body || 'Reviewer requested changes.', 1200),
        url: review.url,
        createdAt,
      } as PrSignal;
    });
}

function mergeConflictSignal(pr: any): PrSignal | null {
  const mergeableState = String(pr.mergeable_state ?? 'unknown');
  const mergeable = pr.mergeable as boolean | null | undefined;
  if (mergeable !== false || mergeableState !== 'dirty') return null;

  const headSha = String(pr.head?.sha ?? '');
  const baseSha = String(pr.base?.sha ?? '');
  const baseRef = String(pr.base?.ref ?? 'base');
  const headRef = String(pr.head?.ref ?? 'PR branch');

  return {
    id: `merge-conflict:${headSha}:${baseSha}:${mergeableState}`,
    kind: 'merge_conflict',
    headSha,
    summary: `PR branch has merge conflicts with ${baseRef}`,
    details: [
      `GitHub reports mergeable=false and mergeable_state=dirty for ${headRef}.`,
      `Reconcile ${headRef} with ${baseRef}${baseSha ? ` (${baseSha.slice(0, 12)})` : ''}, resolve conflicts, and push the PR branch.`,
    ].join(' '),
    url: pr.html_url,
    createdAt: new Date().toISOString(),
  };
}

export async function collectPrSnapshot(watch: PrWatch, extraSignals: PrSignal[] = []): Promise<PrSnapshot> {
  const { token, octokit } = await getInstallationAuth(watch.repo);
  const { owner, name } = splitRepo(watch.repo);
  const pr = await octokit.pulls.get({ owner, repo: name, pull_number: watch.prNumber }).then((r) => r.data);
  const headSha = pr.head.sha;
  const checks = await checkRunSignals(octokit, watch.repo, headSha);
  const [threadSignals, decisionSignals] = await Promise.all([
    reviewThreadSignals(token, watch.repo, watch.prNumber),
    reviewDecisionSignals(token, watch.repo, watch.prNumber),
  ]);
  const mergeSignal = mergeConflictSignal(pr);
  const state: PrSnapshot['state'] = pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';
  return {
    repo: watch.repo,
    prNumber: watch.prNumber,
    prUrl: pr.html_url,
    headBranch: pr.head.ref,
    headSha,
    state,
    ciState: checks.ciState,
    mergeable: pr.mergeable,
    mergeableState: (pr as any).mergeable_state,
    baseBranch: pr.base.ref,
    baseSha: pr.base.sha,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    signals: [...checks.signals, ...threadSignals, ...decisionSignals, ...(mergeSignal ? [mergeSignal] : []), ...extraSignals],
  };
}

export function signalFromReviewWebhook(body: Record<string, any>): PrSignal | null {
  const review = body.review;
  if (!review || String(review.state).toLowerCase() !== 'changes_requested') return null;
  return {
    id: `review-state:${review.id}:${review.submitted_at ?? review.updated_at ?? Date.now()}`,
    kind: 'review_feedback',
    summary: `Review requested changes by ${review.user?.login ?? 'reviewer'}`,
    details: compactText(review.body || 'Reviewer requested changes.', 1200),
    url: review.html_url,
    createdAt: review.submitted_at ?? new Date().toISOString(),
  };
}

export function signalFromPrCommentWebhook(body: Record<string, any>): PrSignal | null {
  const comment = body.comment;
  if (!comment?.body) return null;
  const text = String(comment.body);
  if (!/(^|\s)(@?hermes|\/hermes|please fix|can you address)/i.test(text)) return null;
  return {
    id: `pr-comment:${comment.id}:${comment.updated_at ?? comment.created_at}`,
    kind: 'review_feedback',
    summary: `Top-level PR comment by ${comment.user?.login ?? 'reviewer'}`,
    details: compactText(text, 1500),
    url: comment.html_url,
    createdAt: comment.created_at ?? new Date().toISOString(),
  };
}
