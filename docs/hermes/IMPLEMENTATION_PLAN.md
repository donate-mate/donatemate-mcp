# Hermes — Agentic Coding Platform: Implementation Plan

Self-hosted, always-on harness that orchestrates multiple FE/BE coding agents for
DonateMate, reachable via Slack (desktop + mobile), Jira automation, and MCP. Lives in
the `donatemate-mcp` CDK app as an optional stack (`--context deploy-hermes=true`),
modeled on the existing `figma-vm-stack.ts` / `moltbot-stack.ts` pattern but built on
**ECS Fargate** instead of a pet VM.

> **Scope reality (read first).** All five phases to production quality is multi-day work.
> A focused 2-hour session realistically lands **Phase 1 deployed** (control plane + queue +
> tables + one FE worker that clones and runs the agent) plus **scaffolding** (task defs, IAM,
> trigger stubs) for later phases. The "2-Hour Execution Order" section marks exactly what is
> in-scope for the window and the cut-lines if we run short.

---

## Decisions locked (Q1–Q4)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | GitHub auth | **Dedicated GitHub App** "DonateMate Hermes", installed on **`donate-mate/donatemate-app`** (FE) + **`donate-mate/donatemate`** (BE). Perms: Contents R/W, Pull requests R/W, Issues R/W, Checks R, Actions R/W. App webhook off for MVP. Short-lived installation token minted per job. |
| Q2 | Team interface | **Separate Slack app** "Hermes", **Events API** (not Socket Mode), **@mention-driven and conversational** (multi-turn in-thread + DMs). Control plane keeps thread→session state. |
| Q3 | QA scope | **Front-end only.** FE preview is **Expo/EAS** (not a web URL) → Playwright does not apply. **Today = QA gate v0** (lint/type/build + surface EAS preview link to PR/Slack/Jira for on-device human QA). **Target follow-up = Option B**: AWS Device Farm + Maestro automated mobile E2E. |
| Q4 | Build defaults | Engine = **Claude Code headless** (Codex added in Phase 3). Env = **staging**. Compute = **Fargate throughout** (no emulator infra needed — QA goes to Device Farm). Region **us-east-2**, account **690788838096**. |

**Status:** decisions closed. Remaining blockers = two human-gated setup tasks (create the
GitHub App + Slack app and hand over credentials — see Pre-flight). Everything else can be
built in parallel now.

---

## Repo map & facts (local folder ≠ GitHub repo name)

| Role | GitHub repo | Local folder | Notes |
|------|-------------|--------------|-------|
| **Front-end** | `donate-mate/donatemate-app` | `donatemate-app` | Expo / React Native, Expo SDK ~54. No `react-native-web`. |
| **Back-end** | `donate-mate/donatemate` | `donatemate-lambdas` | Lambda monorepo (CDK). |
| Infra (this) | `donate-mate/donatemate-mcp` | `donatemate-mcp` | CDK app; HermesStack added here. |

- **FE preview pipeline** = `donatemate-app` **`.github/workflows/deploy-dev.yml`** — *lives on the
  `staging` branch*. Trigger: PR label `deploy-dev` (also recognizes `deploy-preview` /
  `needs-preview` / `test-preview` elsewhere). Runs **lint + type-check**, publishes an **EAS
  Update** to branch `pr-<number>`, and on native-impacting file changes queues an **EAS native
  build** (`eas build --profile development --platform all`). Needs `EXPO_TOKEN`. **Output is a
  mobile artifact (OTA update / dev-client build), not a browser URL.**
- **BE PR environments** = `donatemate/.github/workflows/pr-environment-deploy.yml` (CDK PR envs,
  label `deploy-preview`/`needs-preview`/`test-preview`). Not in QA scope for the MVP.
- **Prior art to reuse:** `donatemate-lambdas-agent-review` (TS Claude-API agent loop, prompts,
  build/test validation), `donatemate-lambdas-fix-runner` (`fix_runner.py`).
- **CDK app:** `packages/infrastructure/bin/app.ts` — optional stacks gated by
  `--context deploy-X=true` (`deploy-figma-vm`, `deploy-knowledge`, `deploy-moltbot`). Add
  `deploy-hermes`.
- **Reuse from `mcp-stack.ts`:** Cognito OAuth pool `us-east-2_IO0jDqrUE`, ACM/custom-domain
  pattern, Secrets Manager conventions, SSM exports. Existing secrets to reuse:
  `donatemate/staging/anthropic-api-key`, `/donatemate/staging/knowledge/jira`.

---

## Architecture (target)

```
 Mobile/Desktop ── Slack @Hermes (Events API, conversational) ─┐
 Jira automation (webhook) ────────────────────────────────────┤→ HERMES CONTROL PLANE
 MCP (dm_hermes_*) ─────────────────────────────────────────────┘   (always-on, multi-AZ Fargate)
                                hermes.donate-mate.com (ALB + ACM)
                                • intake + auth + thread→session state
                                • policy/budget gates
                                • DynamoDB jobs · SQS dispatch (+DLQ) · Secrets Manager
                                • EventBridge notify · CloudWatch · S3 artifacts
                                          │ enqueue
                                          ▼  (autoscale on queue depth)
                           WORKER POOL (ECS Fargate — clean container per job)
                           fe-worker · be-worker · qa-orchestrator
                           per-job: shallow clean clone, per-job GitHub App token,
                           bounded role, token/iteration budget cap → artifacts to S3
```

**Key principle:** Hermes owns orchestration (queue, state, routing, channels, policy). The
coding brain inside each worker is **Claude Code headless** (Phase 1), Codex CLI added Phase 3.
We do not reimplement an agent loop. **"100% uptime"** = HA control plane (Fargate desiredCount
≥ 2 across AZs; DynamoDB/SQS managed-HA); workers scale from a warm floor — never a pet.

---

## Pre-flight (human-gated — do these now)

### GitHub App "DonateMate Hermes" (org owner)
1. `https://github.com/organizations/donate-mate/settings/apps` → **New GitHub App**.
2. Name `DonateMate Hermes`; Homepage `https://mcp.donate-mate.com`; **Webhook → uncheck Active**.
3. Repository permissions: **Contents** R/W, **Pull requests** R/W, **Issues** R/W, **Checks**
   read-only, **Actions** R/W (Metadata read-only auto). Install scope: **Only on this account**.
4. Create → note **App ID**; **Generate a private key** (`.pem`).
5. **Install App** on `donate-mate` → **Only select repositories** → `donatemate-app` +
   `donatemate` → Install. Note the **Installation ID** (trailing number in the install URL).
6. Hand over: **App ID + Installation ID + private key** → stored in
   `donatemate/staging/hermes/github-app`. *(Private key may be placed directly in the secret
   instead of shared, if preferred.)*

### Slack app "Hermes" (workspace admin)
1. `https://api.slack.com/apps` → **Create New App → From scratch** → name `Hermes`, DonateMate
   workspace.
2. **Bot Token Scopes:** `app_mentions:read`, `chat:write`, `chat:write.public`,
   `channels:history`, `im:history`, `im:write`, `users:read`.
3. **Event Subscriptions:** Enable ON. **Request URL — DEFERRED** until the control plane is
   deployed (`https://hermes.donate-mate.com/slack/events`); verify it after Phase 1.
   Subscribe to bot events: `app_mention`, `message.im` (add `message.channels` later for
   mention-less thread follow-up).
4. **Install to Workspace** → copy **Bot User OAuth Token** (`xoxb-…`); Basic Information → copy
   **Signing Secret**.
5. Hand over: **bot token + signing secret** → stored in `donatemate/staging/hermes/slack`.
   (No app-level token — Events API, not Socket Mode.)

### Claude-side scaffolding (no human gate — can start now)
- Create empty secrets: `donatemate/staging/hermes/github-app`, `…/slack`,
  `…/jira-webhook` (shared secret for Jira automation inbound).
- Create ECR repos: `donatemate-hermes-control-plane`, `donatemate-hermes-worker`.
- Reuse existing `donatemate/staging/anthropic-api-key` (engine) and
  `/donatemate/staging/knowledge/jira` (Jira posting via existing `dm_jira_*`).

---

## Phase 1 — Control plane + FE worker (deployable core)

**`packages/infrastructure/lib/hermes-stack.ts`** (new): default-VPC lookup; `ecs.Cluster`;
control plane = `ApplicationLoadBalancedFargateService` (desiredCount 2, multi-AZ) → ACM +
Route53 `hermes.donate-mate.com` *(cut-line: ALB DNS if domain slips)*, health `/health`;
`HermesJobs` DynamoDB (pk `jobId`, GSI status, TTL); SQS `HermesJobs` + DLQ (maxReceive 3);
S3 `hermes-artifacts` (encrypted, lifecycle); `fe-worker` Fargate service (warm floor 1,
autoscale on SQS visible-messages, 2–4 vCPU / 8 GB); **separate least-privilege roles**
(control-plane: SQS send + DDB RW + secrets read; fe-worker: SQS consume + DDB RW + S3 write +
secrets read; **no prod-MCP resource access**); CloudWatch log groups.

**`packages/infrastructure/bin/app.ts`** (modify): add `deploy-hermes` gate (mirror moltbot).

**`packages/hermes-control-plane/`** (new, TS/Fastify): routes `POST /slack/events` (verify
signing secret; handle `app_mention` + `message.im`; **conversational — map Slack thread_ts →
job/session, support multi-turn**), `POST /jira/webhook` (verify shared secret), `GET /health`,
`GET /jobs/:id`, `POST /dispatch`. On task → write DDB job (`queued`) + enqueue SQS
`{jobId, type, repo, branch, prompt, threadTs, source}` → ack in-thread. Dockerfile.

**`packages/hermes-worker/`** (new, TS): long-poll SQS → mint per-job GitHub App installation
token → `git clone --depth=1` target repo into `/work/<jobId>` (clean, ephemeral) → checkout
`hermes/<jobId>` → run **Claude Code headless** with prompt + repo context under **budget caps**
(max tokens/iterations + hard timeout) → commit/push → open PR via GitHub App → update DDB +
post PR link to Slack thread + Jira (`dm_jira_*`). Dockerfile (node + git + Claude Code CLI).

**Acceptance:** `@Hermes <small task>` in Slack → worker opens a PR on the target repo + posts
the link back. (2-hour stretch; smoke target = clone + agent run + branch push.)

---

## Phase 2 — FE QA gate v0 (today-feasible) → Option B (target)

**Today (v0, in scope):** on a `deploy-dev`-labeled FE PR, Hermes verifies the checks
`deploy-dev.yml` already runs (lint, type-check, EAS publish success) and **posts pass/fail +
the EAS preview link/QR** to the PR, Slack thread, and Jira ticket for one-tap on-device human
QA. No new test infra. *(Trigger source: GitHub PR/check webhook to Hermes, or Slack/Jira
command — decide at build time; App webhook is currently off, so MVP triggers via Slack/Jira or
adds a minimal webhook.)*

**Target (Option B, follow-up, multi-day):** automated mobile E2E — Hermes orchestrates
`eas build` → submit artifact + **Maestro** flows to **AWS Device Farm** (keeps it in the AWS
/ IAM boundary) → collect pass/fail + video → post to PR/Jira. First flow: login → core
donation screen. **No existing Maestro/Detox flows or device-farm infra today — this is net-new.**

---

## Phase 3 — BE worker + second engine
Add `be-worker` task def (backend toolchain). Add **Codex CLI** as an alternate engine;
per-job/label engine selection. Keep provider adapters pluggable; Hermes (not a provider) holds
the GitHub App token.

## Phase 4 — Concurrency / scale + fix-on-QA-fail
Target-tracking autoscaling per worker on queue depth; global max-concurrency cap; gated
fix loop (QA fail → enqueue `fe-worker` fix job referencing failing PR + artifacts; never
auto-merges).

## Phase 5 — Policy / approval / observability hardening
No prod mutations; no auto-merge (required checks + human review); repo allowlist + branch
policy; per-job + org-daily budget caps with kill switch; full transcript per job to encrypted
S3 with retention; CloudWatch dashboard (success rate, $/PR, queue depth) + alarms (DLQ, worker
errors, budget); written secret/data-egress policy.

---

## 2-Hour Execution Order

| Time | Block | In-scope outcome |
|------|-------|------------------|
| 0:00–0:20 | **Pre-flight** | Andrew creates GitHub App + Slack app (parallel); Claude creates empty secrets + ECR repos. |
| 0:20–1:10 | **Phase 1 infra + code** | `hermes-stack.ts`, `bin/app.ts` gate, `hermes-control-plane` + `hermes-worker` skeletons; `cdk synth` clean. |
| 1:10–1:30 | **Build + deploy** | Build & push both images to ECR; `cdk deploy DonateMate-Hermes-Staging --context deploy-hermes=true`. |
| 1:30–1:45 | **Wire Slack Request URL** | Now that the ALB is live, set Slack Event Subscriptions URL → verify. |
| 1:45–1:55 | **One path E2E** | `@Hermes` → /dispatch → SQS → worker clones + runs Claude Code; iterate toward real PR if time. |
| 1:55–2:00 | **Scaffold rest** | Stub `be-worker`/`qa-orchestrator` + phase 2–5 trigger contracts; commit. |

**Honest end-state at 2:00:** Phase 1 control plane + queue + tables + S3 **deployed to
staging**; an `fe-worker` that consumes a job, clones, and invokes the agent (full PR-open +
Slack/Jira round-trip may need short follow-up). Phases 2–5 scaffolded, not functional.

**Cut-lines if short (in order):** (1) ALB DNS instead of custom domain; (2) control-plane auth
= Slack signature + shared secret only (defer Cognito); (3) single worker, no autoscaling;
(4) defer QA gate entirely; (5) PR-open via REST if GitHub App slips (App strongly preferred).

---

## Top risks / honest caveats

1. **GitHub App + Slack app are human-gated**; App blocks PR-opening. Start both at minute 0.
2. **Slack Request URL is chicken-and-egg** — can only verify after the control-plane ALB is
   live (handled in the 1:30 block). Everything else in Slack setup can finish now.
3. **Container build/push + first ECS deploy eats wall-clock** (image pulls, ALB health). Most
   likely overrun.
4. **Agent-in-container details**: Claude Code headless auth, and keeping git creds *out* of the
   sandbox (mint token at push time) — easy to get subtly wrong.
5. **FE QA is mobile (Expo/EAS), not web.** Real automated E2E (Option B, Device Farm + Maestro)
   is net-new and multi-day; today is the v0 gate only.
6. **Cost**: multiple always-on workers + Opus/Codex per job. Budget caps + warm-floor (not
   warm-peak) are Phase 1, not hardening-later.
7. **"100% uptime"** delivered as HA (multi-AZ Fargate ≥2), not a literal 100% SLO.
8. **Trust boundary**: Hermes worker roles must not be able to touch the production MCP's
   resources — separate stack *and* separate least-privilege IAM.
