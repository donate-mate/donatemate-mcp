# HERMES.md — repository contract (reference copy)

This is the **canonical reference** for the `HERMES.md` file that must live at the **root of each
target repository** Hermes works in (e.g. `donate-mate/donatemate`, `donate-mate/donatemate-app`).

At job start the worker reads `HERMES.md` from the cloned repo root and injects it **verbatim** into
the coding agent's prompt (see `packages/hermes-worker/src/contract.ts`). If the file is absent the
worker logs a warning and proceeds — so adopting it is backward/forward compatible. Copy this file to
the target repo as `HERMES.md` and tailor sections 1–7 to that repo.

---

## 1. Scope

Hermes edits files only; the harness owns git and opens the PR. Make the change described by the
ticket and nothing more. Prefer the narrowest correct fix.

## 2. Toolchain

Dependencies are installed for you (with lifecycle scripts) and the Prisma client is generated before
you start. Run the repo's own tests: `yarn workspace <pkg> test` (or the package's `test` script).
The pre-commit gate runs prettier/eslint/tests on the packages you changed — keep them green.

## 3. Root cause over symptom

Fix the **first writer** of bad state, not a downstream reader. If corrupted data was persisted,
you must also repair the existing records (a migration or fixture), not only prevent new corruption.

## 4. Caller coverage

When you change a function signature or add a parameter, update **every** call site. Search the whole
workspace.

## 5. API contracts

For any API surface change, update the OpenAPI spec / generated SDK / typed client in the same PR.

## 6. Tests

New/changed behavior needs tests that actually execute locally and meet the repo's coverage
thresholds (90%). Do not weaken thresholds or delete tests to go green.

## 7. Evidence for backend defects/alerts

Use AWS CLI evidence (CloudWatch alarms/metrics/logs, Synthetics) before changing code or alarms.
State whether the alarm was a false positive, misconfigured, or a real source defect. If the ticket
carries staging record IDs (donation/request IDs), re-run the fixture or query those exact records
after the fix and report before/after.

## 8. Required PR outcome report (MANDATORY)

Before the PR opens, write an outcome report to **`HERMES_REPORT.md`** at the repo root (the harness
folds it into the PR description and validates it). It MUST contain a heading for each of these six
sections:

- **Root cause** — the true first writer/source of the defect.
- **Evidence** — logs/metrics/queries/repro that prove the diagnosis.
- **Verification** — the tests/commands you ran and their results.
- **Blast radius** — what else this change can affect; callers touched.
- **Data repair** — how existing corrupted records were fixed (or "N/A — no persisted corruption").
- **Deferred** — anything intentionally left out, with a follow-up ticket key (`DM-####`).

A missing report triggers one repair round, then the PR opens with an "⚠️ incomplete report" marker.
