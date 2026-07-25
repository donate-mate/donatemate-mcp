# Hermes Architecture

Hermes is DonateMate's self-hosted, autonomous Jira→PR coding agent. It takes a work
request — a Jira ticket assigned to it, a Slack conversation, or a programmatic dispatch —
plans the change, gets human confirmation, runs an AI coding engine against a clean clone of
the target repository, opens a pull request, and then keeps that PR healthy: it monitors CI
and code-review feedback, pushes scoped auto-repair commits, and after merge drives a
deployment-verification / QA-proof step. Throughout, it writes progress back to the Jira board
and Slack so humans always see what it is doing.

This document describes the system **as found in the source**. File references are relative to
the repo root (`packages/…`).

---

## 1. High-level overview

The end-to-end happy path for a Jira-sourced task:

1. **Assigned** — A Jira Automation rule fires when a ticket is assigned to the Hermes account.
   The control plane derives a short implementation **plan** (OpenAI chat model) and comments it
   on the ticket, awaiting confirmation. No code is written yet.
2. **Refine (optional)** — Non-`/go` comments on the ticket conversationally refine the plan
   (same chat engine), until the plan is right.
3. **Confirm** — A `/go` reply queues the **implementation** coding job, moves the ticket to
   *In Progress*, and records the run in DynamoDB.
4. **Code** — A worker picks the job off SQS, clones the repo on a fresh branch, runs the
   **Codex** coding engine (which edits files only), commits + pushes, and **opens a PR**. The
   ticket moves to *Code Review*; a `prwatch` record starts watching the PR.
5. **Auto-repair loop** — GitHub webhooks and a periodic reconcile loop reduce CI failures,
   review comments, and merge conflicts to compact **signals**. Each *new* actionable signal
   enqueues a short scoped follow-up job (`ci_fix` / `review_fix` / `merge_conflict_fix` /
   `combined_followup`) that pushes back to the same PR branch. Bounded by `MAX_FIX_ATTEMPTS`.
6. **Ready** — When CI passes and no unresolved review feedback remains, Hermes marks the PR
   ready for human review.
7. **Merge → verify** — On merge, Hermes queues a post-merge job: **deploy_verification** (BE)
   or **qa_proof** (FE). It waits for the deploy/build workflow, then either advances the ticket
   toward *Ready for QA* / *Done* or blocks it with a reason.
8. **Learn** — The merge reconcile promotes only accepted, trusted human-review feedback into
   repo-scoped review memory. Future related jobs retrieve a small ranked set before coding.

Slack and programmatic `/dispatch` requests join at step 3/4 (they skip the Jira plan/confirm
handshake but produce the same coding job and PR-watch lifecycle).

---

## 2. Components

Hermes is two deployables sharing one DynamoDB table, one SQS queue, and one S3 bucket.

### 2.1 Control plane — `packages/hermes-control-plane`

An always-on Fastify HTTP service (`src/index.ts`) behind a public ALB. It is the intake surface
and the PR-reconciliation brain. It never runs the coding engine itself; it only creates job rows
and enqueues them.

**HTTP routes** (`src/index.ts`):

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | none | ALB health check (`200 {status:ok}`) |
| `/slack/events` | POST | Slack HMAC (`verifySlackSignature`) | @mention + DM conversational intake; async-processed after 3s ack |
| `/slack/commands` | POST | Slack HMAC | `/start` slash command → queue from the active conversation |
| `/jira/webhook` | POST | shared secret header `x-hermes-secret` | Jira Automation phases: `assigned` / `confirm` / `comment` / `done` (+ legacy direct-prompt) |
| `/github/webhook` | POST | GitHub HMAC (`verifyGitHubSignature`) | PR / CI / review events → `reconcilePrWatch` |
| `/github/reconcile` | POST | shared secret | Manual trigger of `reconcileOpenPrs` |
| `/dispatch` | POST | shared secret | Programmatic (MCP/internal) job creation from a raw `prompt` |
| `/jobs/:id` | GET | none | Read a job row |

**Jira webhook phase handlers** (all in `src/index.ts`):

- `handleJiraAssigned(issueKey)` — reads the issue, routes it to a repo/worker-type, skips
  design-only tickets, derives a plan via `planIssue`, stores a `jiraflow` record in state
  `awaiting_confirm`, seeds a fresh per-ticket conversation, and comments the plan.
- `handleJiraComment(issueKey, text, author)` — while `awaiting_confirm`, refines the plan
  conversationally (`converse`, `/go` as the confirm keyword). Ignores Hermes's own comments.
- `handleJiraConfirm(issueKey, author)` — on `/go`, condenses the refined conversation into a
  task (`conversationToTask`) if it was refined, creates the `implementation` job, flips the
  flow to `running`, and transitions the ticket to *In Progress*.
- `handleJiraDone(issueKey)` — on a ticket reaching Done, runs QA-scenario capture
  (`captureQaScenarioForDone`); blocks the ticket if it needs a human.

**Intent routing** (`src/index.ts`): `routeIntentFromJira` picks the worker type + repo from Jira
signals in priority order — `frontend`/`backend` labels, then an `FE:`/`BE:` summary prefix, then
text heuristics (`hasBackendTextSignal`). `design` label / `Design:` prefix marks non-coding
tickets. Free-text requests use `routeIntent`. Default repos: FE →
`donate-mate/donatemate-app`, BE → `donate-mate/donatemate`, QA → `donate-mate/donatemate-app`.

**PR reconcile loop** (`src/prMonitor.ts`): both webhook-driven and periodic
(`PR_RECONCILE_SECONDS`, default 300s; `setInterval` in `index.ts`). `reconcilePrWatch` collects a
PR snapshot, dedupes new signals, and either starts a follow-up fix job, marks the PR ready, or —
on merge — kicks off post-merge verification. Conditional DynamoDB writes (`src/prWatch.ts`) make
this safe to run from multiple control-plane tasks concurrently. GitHub deliveries are de-duplicated
via `ghevent:<delivery-id>` rows.

**Conversational + planning layer** (`src/converse.ts`): thin wrapper over the OpenAI Chat
Completions API. `CONVERSE_MODEL` (default `gpt-5.3-chat-latest`). Provides `converse` (gather
requirements), `conversationToTask` (condense transcript → task spec), `planIssue` (reviewer-facing
plan), and `draftQaScenario`.

Supporting modules: `src/jira.ts` (read issue context / find `DM-###` keys), `src/jiraBot.ts`
(write-backs as the Hermes bot account + workflow column mapping), `src/slack.ts` (signature verify
+ post), `src/convo.ts` (conversation store), `src/qaPlanner.ts` / `src/qaConfluence.ts` /
`src/qaCapture.ts` (QA plan building + Confluence scenario capture), `src/markdownAdf.ts` (markdown
→ Jira ADF).

### 2.2 Worker — `packages/hermes-worker`

A headless Fargate service (`src/index.ts`) with **no inbound**; it long-polls SQS and processes
one job at a time. The image bundles `git` and the `codex` CLI. It owns all git operations and the
coding engine.

**SQS loop** (`src/index.ts`): `ReceiveMessage` with `WaitTimeSeconds: 20`,
`VisibilityTimeout: 3600`, `MaxNumberOfMessages: 1`. On success the message is deleted; on any
throw the message is left undeleted → SQS redelivers up to `maxReceiveCount: 3`, then DLQ. While a
job runs the task sets **scale-in protection** (`taskprotection.ts`) so the autoscaler cannot kill
it mid-job, and emits a **heartbeat** (`touchJob`, `JOB_HEARTBEAT_SECONDS`, default 60s) so the
monitor can detect a stalled fix job.

**Job kinds** (`src/index.ts` `processJob` dispatch):

| Kind | Meaning | Branch handling | Terminal action |
|------|---------|-----------------|-----------------|
| `implementation` | Initial coding task | fresh `hermes/<jobId8>` branch off `baseBranch` | opens a PR, records `prwatch`, → *Code Review* |
| `ci_fix` | CI failure follow-up | clones existing PR head branch, pushes back | → *Waiting CI* |
| `review_fix` | Review-comment follow-up | same PR branch | → *Waiting CI* |
| `combined_followup` | Mixed CI + review signals | same PR branch | → *Waiting CI* |
| `merge_conflict_fix` | Resolve conflicts vs base | harness pre-merges base, agent resolves | → *Waiting CI* (or auto-completes if merged cleanly) |
| `qa_proof` | Post-merge FE QA / readiness | no clone; drives build + QA workflows (`qaRunner.ts`) | → Ready for QA / Done, or Blocked |
| `deploy_verification` | Post-merge BE deploy verify | no clone; waits on deploy workflow (`deployVerifier.ts`) | → Ready for QA, or Blocked |

**Coding job flow** (`processJob`): update job → running; set scale-in protection; `mkdtemp`
workspace; mint a per-job GitHub installation token; clone (base branch for new work, PR head
branch for follow-ups); for `merge_conflict_fix`, pre-merge the base and build a conflict prompt;
enrich the prompt with Jira context if the source references a ticket; retrieve relevant accepted
review lessons (`reviewLearning.ts`); run the agent; if the tree
changed, commit + push (with pre-commit repair loop), open/update the PR, and write back to
Jira/Slack/GitHub. If the agent produced **no changes**, the job fails with an explanatory comment
and (for initial jobs) the ticket moves back to *To Do*.

**Pre-commit repair** (`commitAndPushWithPrecommitRepair`): if the commit hook fails on
lint/format/typecheck, the harness re-invokes the agent with a scoped repair prompt up to
`PRECOMMIT_REPAIR_ATTEMPTS` (default 2) times before giving up.

Supporting modules: `src/github.ts` (App auth, clone, branch, commit/push, PR, labels, workflow
dispatch/polling, merge-conflict prep), `src/agent.ts` (Codex engine — see §4), `src/jira.ts` /
`src/jiraBot.ts` (context + write-backs incl. `assignIssue`, `createLinkedDefect`, `setFixVersion`),
`src/notify.ts` / `src/slackFormat.ts` (Slack), `src/qaRunner.ts` + `src/deployVerifier.ts`
(post-merge verification), `src/taskprotection.ts` (ECS scale-in protection).

---

## 3. Job lifecycle & DynamoDB records

All state lives in one DynamoDB table (`donatemate-<env>-hermes-jobs`), partition key `jobId`,
`PAY_PER_REQUEST`, TTL attribute `expiresAt`, and a `status-index` GSI (partition `status`, sort
`createdAt`). The `jobId` field is overloaded as a generic primary key: real jobs use a UUID,
while flow/watch/dedup records use a **synthetic prefix key**. Row kinds:

### 3.1 `job-<UUID>` — a unit of work (`hermes-control-plane/src/jobs.ts`, `hermes-worker/src/jobs.ts`)

| Field | Type | Notes |
|-------|------|-------|
| `jobId` | string | UUID (PK) |
| `kind` | string | one of the 7 job kinds (default `implementation`) |
| `type` | string | `fe` \| `be` \| `qa` |
| `status` | string | `queued` \| `running` \| `done` \| `failed` |
| `repo` | string | `owner/name` |
| `baseBranch` | string | defaults: FE/QA `staging`, BE `main` |
| `prompt` | string | task text (or a JSON plan for qa/deploy jobs) |
| `source` | string | `slack` \| `dispatch` \| `jira:<KEY>` \| `github:<repo>#<pr>` |
| `channel`, `threadTs` | string | Slack write-back target |
| `requestedBy` | string | Slack user |
| `parentJobId` | string | source job for follow-ups |
| `prNumber`, `prUrl`, `headBranch`, `headSha` | | PR linkage |
| `issueKey` | string | Jira key |
| `feedbackSummary` | string | compact signals a follow-up must address |
| `qaPlanUri` | string | S3 URI of a QA/deploy plan |
| `createdAt`, `updatedAt` | ISO string | `updatedAt` doubles as the heartbeat |
| `expiresAt` | number | epoch seconds, 30-day TTL |
| `error`, `failureLogUri`, `transcriptUri` | | failure/diagnostics |

Written by `createJob` (also sends `{jobId,type}` to SQS); mutated by `updateJob` /
`touchJob` (worker side). Run transcripts and JSON artifacts are offloaded to S3
(`storeTranscript` → `jobs/<jobId>/transcript.txt`, `storeJsonArtifact`).

### 3.2 `jiraflow:<ISSUE-KEY>` — plan→confirm handshake state (`hermes-control-plane/src/jiraflow.ts`)

| Field | Type | Notes |
|-------|------|-------|
| `jobId` | string | `jiraflow:<KEY>` (PK) |
| `status` | string | `awaiting_confirm` \| `running` \| `done` |
| `taskPrompt` | string | plan-derived implementation prompt |
| `repo`, `type` | string | routed target |
| `plan` | string | reviewer-facing plan text |
| `flowJobId` | string | the queued coding job's id (exposed as `jobId` in `JiraFlow`) |
| `updatedAt`, `expiresAt` | | 30-day TTL |

Its purpose is idempotency: a re-fired Jira webhook (Jira retries) reads the existing flow and
no-ops instead of double-queuing. The worker marks it terminal via `markFlowDone` / `markFlowRunning`.

### 3.3 `prwatch:<repo>#<pr>` — PR auto-repair state (`hermes-control-plane/src/prWatch.ts`, written by worker `jobs.ts`)

| Field | Type | Notes |
|-------|------|-------|
| `jobId` | string | `prwatch:<repo>#<pr>` (PK) |
| `status` | string | `prwatch:watching` \| `:fixing` \| `:qa_queued` \| `:qa_running` \| `:blocked` \| `:done` |
| `jiraState` | string | fine-grained lifecycle: `pr_open` → `fixing_ci`/`fixing_review`/`fixing_merge_conflict` → `waiting_ci` → `ready_review` → `qa_waiting_build` → `ready_qa` → `qa_running` → `qa_passed`/`qa_failed` → `blocked`/`done` |
| `repo`, `prNumber`, `prUrl` | | PR identity |
| `sourceJobId` | string | the implementation job |
| `type`, `baseBranch`, `headBranch`, `headSha` | | build/branch tracking |
| `originalPrompt` | string | fed to follow-up prompts |
| `issueKey`, `channel`, `threadTs` | | write-back targets |
| `fixAttemptCount` | number | budget of *distinct* problems (cap `MAX_FIX_ATTEMPTS`, default 8) |
| `activeFixJobId`, `activeQaJobId` | string | single-flight locks (conditional writes) |
| `handledSignalIds` | list | de-duplication of already-addressed signals |
| `blockReason`, `deployRunUrl` | | block context / deploy link |
| `createdAt`, `updatedAt`, `expiresAt` | | 30-day TTL |

Created by the worker (`recordPrWatch`) when the initial PR opens; all subsequent transitions use
**conditional `UpdateExpression`s** (`tryStartFix`, `markWatchQaQueued`, `markWatchReady`,
`clearActiveFix`, `markWatchBlocked`, `markWatchDone`) so concurrent reconcilers cannot double-act.

### 3.4 `ghevent:<delivery-id>` — webhook idempotency

A tiny row written by `rememberGitHubDelivery` with a 7-day TTL; a conditional `attribute_not_exists`
put makes duplicate GitHub deliveries no-ops.

### 3.5 `review-resolution:<hash>` — timestamped thread-resolution evidence

One delivery-idempotent row per signed `pull_request_review_thread:resolved` webhook, partitioned
on the `status-index` by repo + PR and retained for 30 days. GitHub's GraphQL review-thread object
exposes only the current resolved state, not when it changed, and the generated webhook thread
schema has no resolution timestamp. The control plane therefore records authenticated webhook
receipt time as a conservative observation boundary. A delayed pre-merge delivery may be omitted,
but a post-merge resolution can never be backdated into accepted memory. The repository hooks must
subscribe to **Pull request review thread** events. If evidence is absent or newer than the merge,
the resolved flag alone is fail-closed and does not teach the system. Merged snapshots retry a
missing expected thread row with short bounded backoff to cover `status-index` propagation.

### 3.6 `review-memory:<hash>` — accepted reviewer-feedback memory

One row per accepted review thread or top-level change request. The `status-index` partition is
`review-memory:<repo>`, which lets a worker retrieve the newest bounded candidate set with one
regional DynamoDB query. Rows retain the source PR/thread URL, file/line scope, reviewer association,
acceptance evidence, merge SHA, and feedback hash; they expire after 365 days by default.

The learning gate is intentionally conservative:

1. The feedback author must be a GitHub `OWNER`, `MEMBER`, or `COLLABORATOR`; bots, Hermes, unknown
   authors, acknowledgements, and prompt-injection-shaped text are excluded.
2. Inline feedback needs either a thread-resolution webhook timestamped no later than the merge, or
   a Hermes addressed-marker naming that exact comment with no later human reply. A top-level
   `CHANGES_REQUESTED` body needs a later approval from that reviewer. Marker-based evidence is
   retained only when its claimed fix commit is still in the merged PR's accepted source history.
3. The PR must merge. Closed/unmerged PRs never teach the system. The `hermes-no-learn` PR label
   opts the whole PR out.
4. Capture is event-driven in the merge reconcile path and idempotent by repo + GitHub source ID.
   It is fail-open and cannot block deployment verification.
5. The worker ranks within the same repo using file/module and task-token overlap, deduplicates
   repeated feedback, excludes the current PR, and injects at most five lessons. No relevance match
   means no memory block.
6. Stored reviewer text is delimited and HTML-escaped as untrusted evidence. The prompt explicitly
   forbids treating it as executable instructions or allowing it to override the current task,
   repository contract, or system instructions.

This is non-parametric learning: it improves the next run without modifying model weights. Keep a
holdout set of historical review cases and track repeat-finding rate, first-pass review acceptance,
fix rounds, retrieval precision, lookup latency, and token overhead before broadening the gate or
adding semantic/model-based consolidation.

---

## 4. Coding engine — OpenAI Codex CLI

The engine lives in `packages/hermes-worker/src/agent.ts`. The worker shells out to the **`codex`
CLI** in non-interactive `codex exec` mode. Key facts as-coded:

- **Auth**: `codex exec` reads `~/.codex/auth.json`, *not* `OPENAI_API_KEY`. The harness first runs
  `codex login --with-api-key`, piping the OpenAI key (from `SECRET_OPENAI`) via stdin.
- **Model**: pinned via `AGENT_MODEL` (default `gpt-5.5`) passed as `--model`.
- **Sandbox**: the ephemeral Fargate container *is* the sandbox, so Codex runs with
  `--dangerously-bypass-approvals-and-sandbox`, `--ephemeral`, and `--skip-git-repo-check`.
- **Working dir**: `-C <clonedir>`. The agent's final message is captured to a `-o last.txt` file
  **outside** the clone (so it can't pollute the diff) and surfaced as `reason` (explains e.g. a
  no-change run).
- **stdin** is set to `ignore` — an open/piped stdin makes `codex exec` block waiting for EOF and
  hang the job.
- **Timeout**: hard `JOB_TIMEOUT_SECONDS` (default 2400s) budget guardrail; on expiry the child is
  `SIGKILL`ed and the job fails as timed out. Output is capped at 16 MiB.
- **`CODEX_HOME`** is left at its default under `$HOME` — Codex refuses to create helper binaries
  when `CODEX_HOME` is under `/tmp`, and each task processes one job at a time.

**The harness owns git; the agent only edits files.** Every task is prefixed with
`HARNESS_PREAMBLE`, which instructs the agent to:

- make changes by **editing files in the working directory only**;
- **not** run `git commit/push/checkout/branch`, any `gh` command, or open a PR — the harness
  commits the working tree and opens the PR after the agent finishes;
- leave edits uncommitted and end the turn when done.

The preamble also grants AWS observability guidance for backend/alarm/canary tickets: use the
`aws` CLI (via the worker task role, §5) to gather CloudWatch/Synthetics/Logs evidence *before*
changing code, and to classify an alarm as a false positive, mis-tuned, or a real source defect —
so real defects aren't hidden by weakening alarms.

This design keeps change-detection and PR creation **deterministic**: the harness diffs the working
tree against the clone baseline (`hasChanges(dir, baseSha)`), so a run that touched nothing is
detected and reported rather than producing an empty/malformed PR.

The conversational/planning layer is a **separate** model (`CONVERSE_MODEL` =
`gpt-5.3-chat-latest`) used only by the control plane for planning and chat — not for coding.

---

## 5. Infrastructure & deployment

Defined in `packages/infrastructure/lib/hermes-stack.ts` (CDK). Optional stack, deployed with
`--context deploy-hermes=true`. Region `us-east-2`, account `690788838096`. Container images are
referenced from ECR by tag (`latest`) — **CDK does not build Docker**; images are pushed
separately. Services default to a warm floor; scale via context (`hermes-control-plane-count`,
`hermes-worker-count`, `hermes-worker-max`).

**Stack / resource names** (staging): stack `DonateMate-Hermes-Staging`; ECS cluster
`donatemate-staging-hermes`; control-plane service `donatemate-staging-hermes-control-plane`;
worker service `donatemate-staging-hermes-fe-worker`; ECR repos
`donatemate-hermes-control-plane` and `donatemate-hermes-worker`.

**Data plane**:
- DynamoDB `donatemate-<env>-hermes-jobs` (PK `jobId`, TTL `expiresAt`, GSI `status-index`).
- SQS `donatemate-<env>-hermes-jobs` (visibility timeout **6h** — coding + mobile QA can run long)
  with DLQ `…-hermes-jobs-dlq` (`maxReceiveCount: 3`, 14-day retention).
- S3 `donatemate-<env>-hermes-artifacts-<account>` (transcripts + JSON plans).

**Control plane**: Fargate task (512 CPU / 1024 MiB), container port 3000, in **public** subnets
with public IP, behind an internet-facing ALB `dm-<env>-hermes`. HTTPS:443 listener
(ACM cert, `hermes.donate-mate.com`) forwards to the target group; :80 redirects to :443. Health
check `/health`. Default desired count 2 (HA). Circuit-breaker rollback on deploy.

**FE worker**: Fargate task (2048 CPU / 8192 MiB, **40 GiB** ephemeral storage for clean clones +
`node_modules`), no load balancer, public subnet for egress (ECR/GitHub/OpenAI). Warm floor 1,
autoscales to `workerMax` (default 4) on `ApproximateNumberOfMessagesVisible` (scale out on
backlog, in to the floor when empty; busy tasks are protected from scale-in). Task role also grants
`ecs:UpdateTaskProtection` and a broad **read-only** AWS-observability policy (CloudWatch, Logs,
Synthetics, Lambda, API Gateway, Step Functions, CloudFormation, CodeBuild/CodePipeline,
EventBridge, ECS, X-Ray, and specific Synthetics S3 buckets) for backend defect triage.

**Secrets** (Secrets Manager, imported by name):

| Env var | Secret name | Used for |
|---------|-------------|----------|
| `SECRET_GITHUB_APP` | `donatemate/<env>/hermes/github-app` | GitHub App (appId/installationId/privateKey) |
| `SECRET_SLACK` | `donatemate/<env>/hermes/slack` | Slack signing secret + bot token |
| `SECRET_JIRA_WEBHOOK` | `donatemate/<env>/hermes/jira-webhook` | shared secret for `/jira/webhook`, `/dispatch`, `/github/reconcile` |
| `SECRET_OPENAI` | `donatemate/<env>/hermes/openai` | Codex coding engine + planning/chat |
| `SECRET_ANTHROPIC` | `donatemate/<env>/anthropic-api-key` | legacy, no longer used |
| `SECRET_JIRA` | `/donatemate/<env>/knowledge/jira` | read Jira issue context |
| `SECRET_JIRA_BOT` | `donatemate/<env>/hermes/jira-bot` | write-backs as the hermes@ account |
| `SECRET_DM_MCP` | `donatemate/<env>/hermes/dm-mcp-key` | DonateMate MCP API key (worker) |

**Control-plane task env vars** (`hermes-stack.ts`):

| Var | Value |
|-----|-------|
| `ENVIRONMENT` | `staging` / `production` |
| `JOBS_TABLE`, `JOBS_QUEUE_URL`, `ARTIFACTS_BUCKET` | data-plane handles |
| `SECRET_SLACK`, `SECRET_JIRA_WEBHOOK`, `SECRET_GITHUB_APP`, `SECRET_ANTHROPIC`, `SECRET_OPENAI`, `SECRET_JIRA`, `SECRET_JIRA_BOT` | secret names |
| `CONVERSE_MODEL` | `gpt-5.3-chat-latest` |
| `MCP_ENDPOINT` | `https://mcp.donate-mate.com/mcp` |
| `PR_RECONCILE_SECONDS` | `300` |
| `REVIEW_LEARNING_ENABLED` | `true` |
| `REVIEW_LEARNING_TTL_DAYS` | `365` |
| `REVIEW_LEARNING_OPTOUT_LABEL` | `hermes-no-learn` |
| `QA_BUILD_WORKFLOW_ID` | `staging.yml` |
| `QA_AUTOMATION_ENABLED` | `false` |
| `BE_DEPLOY_WORKFLOW_ID` | `208630294` (donate-mate/donatemate "Deploy to Staging") |

**FE worker task env vars** (`hermes-stack.ts`):

| Var | Value |
|-----|-------|
| `ENVIRONMENT`, `AWS_REGION`, `AWS_DEFAULT_REGION` | env + region |
| `WORKER_TYPE` | `fe` |
| `JOBS_TABLE`, `JOBS_QUEUE_URL`, `ARTIFACTS_BUCKET` | data-plane handles |
| `SECRET_GITHUB_APP`, `SECRET_OPENAI`, `SECRET_JIRA`, `SECRET_JIRA_BOT`, `SECRET_SLACK`, `SECRET_DM_MCP` | secret names |
| `AGENT_MODEL` | `gpt-5.5` (coding model) |
| `MCP_ENDPOINT` | `https://mcp.donate-mate.com/mcp` |
| `JOB_TIMEOUT_SECONDS` | `2400` |
| `REVIEW_LEARNING_ENABLED` | `true` |
| `REVIEW_LEARNING_TOP_K` | `5` |
| `REVIEW_LEARNING_TIMEOUT_MS` | `1500` |
| `REVIEW_LEARNING_MAX_CANDIDATES` | `100` |
| `QA_BUILD_WORKFLOW_ID` | `staging.yml` |
| `QA_EXECUTION_WORKFLOW_ID` | `hermes-qa.yml` |
| `QA_AUTOMATION_ENABLED` | `false` |
| `QA_BUILD_WAIT_SECONDS`, `QA_EXECUTION_WAIT_SECONDS` | `7200` |
| `QA_POLL_SECONDS` | `60` |
| `BE_DEPLOY_WORKFLOW_ID` | `208630294` |
| `DEPLOY_WAIT_SECONDS` | `7200` |
| `DEPLOY_POLL_SECONDS` | `60` |
| `JIRA_BROWSE_BASE_URL` | `https://donatemate.atlassian.net` |
| `FE_TESTFLIGHT_FIX_VERSION`, `FE_TESTFLIGHT_RELEASE_VERSION` | `v61.0.0` |
| `QA_ASSIGNEE_ACCOUNT_ID` / `_NAME` / `_EMAIL` | Patrick Sheehy (FE QA) |
| `BE_QA_ASSIGNEE_ACCOUNT_ID` / `_NAME` / `_EMAIL` | Andrew Sheehy (BE QA) |
| `QA_SLACK_CHANNEL` | `#qa` |
| `QA_SLACK_MENTION`, `BE_QA_SLACK_MENTION` | (empty) |

**SSM exports**: `/donatemate/<env>/hermes/queue-url`, `…/jobs-table`, `…/control-plane-dns`.
CFN outputs include the public base URL, Slack Events URL, GitHub webhook URL, queue URL, and the
two ECR image URIs.

> Note: the CDK stack file provisions a single **FE** worker service (`WORKER_TYPE=fe`). The `be`
> and `qa` worker *types* are job-routing distinctions handled within that worker pool (the FE
> worker also processes BE deploy-verification and QA jobs), not separate services in this stack.

---

## 6. Sequence diagram — assigned → PR → reconcile

```mermaid
sequenceDiagram
    autonumber
    participant Dev as Developer
    participant Jira as Jira (Automation)
    participant CP as Control Plane
    participant OAI as OpenAI (plan/chat)
    participant DDB as DynamoDB
    participant SQS as SQS
    participant W as Worker
    participant Codex as Codex CLI (gpt-5.5)
    participant GH as GitHub

    Dev->>Jira: Assign ticket to Hermes
    Jira->>CP: POST /jira/webhook (phase=assigned)
    CP->>Jira: read issue context
    CP->>OAI: planIssue(context)
    OAI-->>CP: plan
    CP->>DDB: setFlow jiraflow:<KEY> (awaiting_confirm)
    CP->>Jira: comment plan ("reply /go")

    Dev->>Jira: comment "/go"
    Jira->>CP: POST /jira/webhook (phase=confirm)
    CP->>DDB: createJob (implementation, queued)
    CP->>SQS: enqueue {jobId,type}
    CP->>DDB: setFlow running
    CP->>Jira: transition → In Progress

    W->>SQS: long-poll receive
    W->>DDB: updateJob running (+scale-in protection)
    W->>GH: mint installation token, clone base branch
    W->>Codex: runAgent(HARNESS_PREAMBLE + task)
    Codex-->>W: edited working tree
    W->>GH: commit + push branch, open PR
    W->>DDB: recordPrWatch prwatch:<repo>#<pr>
    W->>Jira: comment PR link, transition → Code Review

    GH-->>CP: POST /github/webhook (CI / review / merge)
    Note over CP: also periodic reconcileOpenPrs (every 300s)
    CP->>GH: collect PR snapshot (CI, reviews, conflicts)
    CP->>DDB: dedupe new signals vs handledSignalIds
    alt new actionable signal & attempts < cap
        CP->>DDB: tryStartFix (conditional lock)
        CP->>SQS: createJob (ci_fix/review_fix/…)
        W->>SQS: receive follow-up
        W->>GH: clone PR branch, agent fixes, push
        W->>DDB: markPrWatchWaiting; Jira → Waiting CI
    else CI passing, no open feedback
        CP->>DDB: markWatchReady (ready_review)
        CP->>Jira: transition → Code Review (ready for human)
    else PR merged
        CP->>SQS: createJob (deploy_verification | qa_proof)
        W->>GH: wait for deploy/build workflow
        W->>Jira: → Ready for QA / Done, or Blocked
    end
```

---

## 7. External integrations

**Jira** — two directions:
- *Inbound*: Jira Automation rules POST to `/jira/webhook` with `x-hermes-secret` (matched against
  `SECRET_JIRA_WEBHOOK.sharedSecret`), carrying `{issueKey, phase, author, text}`. Reads use
  `SECRET_JIRA`.
- *Outbound (write-backs)*: `jiraBot.ts` posts comments (markdown → ADF) and transitions issues via
  REST v3 as the **hermes@ Atlassian account** (`SECRET_JIRA_BOT`, falling back to `SECRET_JIRA`).
  `getBotAccountId()` lets Hermes ignore its own comments (no feedback loops). `COLUMN` maps agent
  phases to DonateMate workflow column names (with synonyms); transitions are best-effort no-ops if
  the workflow disallows the move.

**GitHub** — a **GitHub App** with per-job scoped installation tokens (`github.ts`
`getInstallationAuth`): each job mints a ~1h token restricted to the single target repo with
least-privilege permissions (`contents:write`, `pull_requests:write`, `issues:write`,
`checks:read`, `actions:write`, `metadata:read`) — defense-in-depth even if the App is broader.
Tokens are never written to disk. Inbound PR/CI/review events hit `/github/webhook` (HMAC-verified,
delivery-deduped); the App subscribes to **Pull request review thread** events so signed resolution
timestamps can be preserved before merge. The worker clones via
`https://x-access-token:<token>@github.com/…` with retries for token-propagation 404s.

**Slack** — Events API + slash commands at `/slack/events` and `/slack/commands`, HMAC-verified
against `SECRET_SLACK`; both ack within Slack's 3s window and process asynchronously. The control
plane runs the conversational scoping flow (`converse`) and the worker posts PR links / QA results
back to the originating thread (`notify.ts`), threaded on `channel` + `threadTs` carried on the job.

**DonateMate MCP** (`MCP_ENDPOINT` = `https://mcp.donate-mate.com/mcp`, key `SECRET_DM_MCP`) — the
DonateMate MCP server, wired into the environment for the agent (e.g. Jira/Figma/knowledge tools).
The MCP server also exposes Hermes tools (`dm_hermes_create_pr`, `dm_hermes_job_status`) that reach
the control plane's `/dispatch` and `/jobs/:id` endpoints.

**OpenAI** — one API key (`SECRET_OPENAI`) serves two distinct roles: the **Codex CLI** coding
engine on the worker (`AGENT_MODEL=gpt-5.5`) and the **planning/chat** layer on the control plane
(`CONVERSE_MODEL=gpt-5.3-chat-latest`). The legacy Anthropic key (`SECRET_ANTHROPIC`) is imported
but no longer used.
