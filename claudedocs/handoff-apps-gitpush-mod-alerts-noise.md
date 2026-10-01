# Handoff: apps-gitpush-mod-alerts-noise — 2026-09-30

## Run this first — the index, one command
```bash
$DEVRC/scripts/cairn-ops/read.sh recall --repo "/home/zach/workspace/civit/civitai"
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. `scope-absent`/`scope-empty` means
nothing is recorded yet: ordinary, not an error, and not a clean bill of health.
Non-blocking: if it exits non-zero, print the stderr line and carry on.

## Goal
Stop the noisy red `🚨 Apps build-chain rejected: <slug>` Discord ping that fired on every successful direct git push to a canonical `civitai-apps/<slug>` repo, without touching the six genuine failure-stage pings or the shared `DISCORD_WEBHOOK_MOD_ALERTS` webhook (3 producers: 2 health checks + this).
- **closing-condition:** `check` — `gh pr view 5273 --repo civitai/civitai --json state --jq .state` returns `MERGED` (the fix is on `main`; live silence on dp-prod is the separate verification below, gated on the next `main`→`release` cut).

## State now
- **PR #5273 OPEN** — `civitai/civitai`, branch `zach/apps-gitpush-drop-park-ping`, base `main`, commit `a8bca8f8ea`. Worktree kept at `/home/zach/workspace/civit/worktrees/apps-drop-park-ping` (branch has upstream; not merged).
- **DONE this session:** traced the message to its only sender — `notifyModsOfWebhookFailure()` at `<civitai>/src/pages/api/internal/blocks/git-push.ts:471-512` (7 stages, shared webhook id `1489302044660465746`); measured the noise; removed the `unreviewed-push` ping call and updated the function docstring; added 3 regression tests to `git-push.gate.test.ts`.
- **Verification matrix (local, at HEAD `a8bca8f8ea`):** park no-ping tests (fresh + same-sha re-delivery) **red at base `e432c50817`** (watched fail), green at HEAD; failure-stage-still-pings green at both; `git-push.gate.test.ts` + `git-push.test.ts` 28/28; `pnpm run typecheck` 0 errors; eslint 0 errors (7 pre-existing warnings, untouched lines).
- **Deploy/verify status: NOT deployed, NOT verified live.** dp-prod builds from `release`, not `main` — the fix goes live on the next `main`→`release` cut. Nothing on dp-prod has changed this session.
- **CI on the PR: `Unit tests (1)` FAILURE at creation — pre-existing on main, and since FIXED.** The failure was `src/server/services/__tests__/model-file-hash-writer-exemption.test.ts` (552 passed / 1 failed in that shard); my touched files passed. Base commit `e432c50817` on `main` itself shows the same `Unit tests (1)` FAILURE (`gh api repos/civitai/civitai/commits/e432c50817/check-runs?check_name=Unit%20tests%20(1)` → `failure`, completed 2026-10-01T00:21Z). **Resolution observed 2026-10-01 during this session's ff-merge:** `main` head is now `14d7f9f957` — `test(model-file-hash): use the canonical env mock in the writer-exemption test (#5272)` — so the red shard was fixed independently mid-session; #5273's red should clear on its next head/base sync. All other PR checks green.

## Open investigations — live diagnosis state

### ~~Main red on `Unit tests (1)` — `model-file-hash-writer-exemption.test.ts`~~ RESOLVED mid-session by #5272
- as-of: 2026-09-30; RESOLVED 2026-10-01 (was captured against PR #5273's base so the red would not be misattributed to #5273)
- **Symptom + exact repro (historical):** `Unit tests (1)` failed on `src/server/services/__tests__/model-file-hash-writer-exemption.test.ts` at base `e432c50817` on `main` itself (SHA-pinned check-runs: `failure`, 2026-10-01T00:21Z) and in #5273's shard: `Test Files 1 failed | 552 passed (553)`, `ELIFECYCLE Command failed with exit code 1`.
- **Ruled out: "caused by #5273"** — the base commit failed identically 24 min before the PR's run, and the failing file is unrelated to the PR's diff. `via: command`
- **RESOLVED:** `origin/main` head after this session's ff-merge is `14d7f9f957` — `test(model-file-hash): use the canonical env mock in the writer-exemption test (#5272)`, touching the exact failing file. `via: command`

## Next steps (ranked)
1. **Review + merge PR #5273** (`civitai/civitai`, touches `src/pages/api/internal/blocks/git-push.ts` + `git-push.gate.test.ts`). forcing: user — operator asked to disable the noisy "Apps build-chain rejected" report; this PR is that fix. Closes the arc's closing condition.
2. **Verify live silence after the next `main`→`release` cut** (civitai dp-prod): once a release carrying `a8bca8f8ea` is serving, push (or wait for fleet automation to push) to a canonical repo and confirm NO red embed in the mod-alerts channel while `/apps/review` still shows the pending row. forcing: none

## Defects (batched)
- ~~Main red on `Unit tests (1)` at base `e432c50817`~~ — RESOLVED mid-session by `#5272` (see the superseded investigation block above).

## Gotchas / decisions / dead-ends
- **Traefik Loki cannot count park-path pings:** the webhook 202s fast, and the access-log filter only writes `4xx/5xx OR >5s` — so `{namespace="traefik", log_type="access"} |= "git-push"` returns **matched-nothing over 72h** (verified) while pings demonstrably fire. The DB is the counter: push-originated rows are uniquely `coalesce(bundle_key,'')=''` (no MinIO bundle; `forgejo_commit_sha` NOT NULL does NOT discriminate — approve stamps it on ZIP rows too). Ping count ≥ row count: a re-delivery of the same sha re-pings while `recordPendingFromPush` only refreshes the existing row.
- **Shared-webhook disable options that were rejected:** zeroing `DISCORD_WEBHOOK_MOD_ALERTS` kills the 2 health-check producers; the `app-blocks-pipeline-enabled` Flipt kill-switch 503s the whole webhook (breaks the park flow, not just the ping). Code-level stage removal was the only selective fix.
- **civitai worktree recipe** (from its CLAUDE.md, followed this session): worktrees under `/home/zach/workspace/civit/worktrees/<name>`; `worktree add <wt> -b <branch> --no-track origin/main` (deleting a leftover `-b` branch first, or it refuses); `submodule update --init event-engine-common`; `printf 'use flake\n' > .envrc && direnv allow`; `corepack pnpm install --frozen-lockfile` ≈ 13s from the shared store. Tests: `--project 'unit*'` (never bare `unit` — silently skips the 6 `unit-native` files).
- **CI verdicts must be SHA-pinned:** a PR rollup read seconds after `gh pr create` is not a verdict (checks lag the push); `gh api repos/civitai/civitai/commits/<sha>/check-runs` with `completed_at` read is. Used here to attribute the red shard to the base commit rather than the PR.

## How to verify
- Local, in `/home/zach/workspace/civit/worktrees/apps-drop-park-ping`: `corepack pnpm exec vitest run --project 'unit*' src/tests/api/internal/blocks/git-push.gate.test.ts` — 3 new tests: park path (fresh + re-delivery) never calls `fetch`; a manifest-validation failure still POSTs the mod-alerts embed (`title` contains `Apps build-chain rejected`). Red-at-base evidence: checkout `e432c50817`, apply only the test file, both park tests fail.
- Merged + live: `gh pr view 5273 --repo civitai/civitai --json state --jq .state` → `MERGED`; then after the next release cut serves an image built from it, any direct push to a canonical repo must produce a pending row at `/apps/review` and NO mod-alerts embed.
- Live sender check while NOT yet merged (for contrast): `kubectl -n civitai-dp-prod logs -l app=civitai-dp-prod-primary --since=10m` shows nothing useful (fire-and-forget); the observable is the Discord channel itself.
