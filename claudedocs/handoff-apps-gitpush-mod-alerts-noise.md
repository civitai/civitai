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
- **PR #5273 MERGED** — squash-merged **2026-10-01T02:02:35Z** as **`979b9439d8`** on `civitai/civitai` `main`. Branch `zach/apps-gitpush-drop-park-ping` (final head `de794068e9`). **The arc's closing condition is MET: the arc is CLOSED.**
- **Landed content, verified on `origin/main` rather than by ancestry** (a squash merge never makes the branch head an ancestor of the base, so `merge-base --is-ancestor` reads false forever and is the wrong instrument): `git show origin/main:src/pages/api/internal/blocks/git-push.ts | grep -c "unreviewed-push'"` → **0** (the noisy ping is gone); `grep -c "notifyModsOfWebhookFailure({"` → **6** (all six genuine failure stages intact: `fetch-manifest`, `parse-manifest`, `manifest-validation`, `blockId-slug-mismatch`, `iframe-src-mismatch`, `record-pending-review`); the three new tests are present in `src/tests/api/internal/blocks/git-push.gate.test.ts`.
- **The PR's red shard was INHERITED, and that was measured, not inferred.** The prior session concluded #5272 fixed it from its commit title. Confirmed by SHA-pinned read: `Unit tests (1)` is `success` on `main` at **`14d7f9f957`** (#5272's merge, 2026-10-01T00:47:00Z) and still `success` at `0609a865`. #5273's red run completed 00:42:57Z against base `e432c50817` — 2 min after #5272 merged but triggered before it, so the run never contained the fix.
- **Cleared with `gh pr update-branch 5273`, NOT `gh run rerun`** — a rerun replays the event's pinned SHA and therefore cannot clear a red inherited from a moved base. The update moved the branch to `de794068e9`; CI re-ran clean on that head: **13 check-runs, 12 `success` + 1 `skipped`**, the skip being the conditional `Typecheck (main pushes / fork PRs / non-main base)` (by design on a non-main-base PR; typecheck is still covered by `App unit tests + typecheck`). All `completed_at` between 01:56Z and 02:02Z, i.e. after the update — so the verdict is this head's, not a stale rollup's.
- **Carried forward — the local verification matrix at the pre-merge head `a8bca8f8ea`:** park no-ping tests (fresh + same-sha re-delivery) **red at base `e432c50817`** (watched fail), green at HEAD; failure-stage-still-pings green at both; `git-push.gate.test.ts` + `git-push.test.ts` 28/28; `pnpm run typecheck` 0 errors; eslint 0 errors (7 pre-existing warnings, untouched lines).
- **Deploy/verify status: MERGED to `main`, NOT deployed, NOT verified live.** dp-prod builds from `release`, not `main`. The noisy red embed will keep firing on direct pushes until the next `main`→`release` cut serves an image carrying `979b9439d8`. Nothing on dp-prod changed in either session.
- Worktree `/home/zach/workspace/civit/worktrees/apps-drop-park-ping` is now merged and removable.

## Open investigations — live diagnosis state

### ~~Main red on `Unit tests (1)` — `model-file-hash-writer-exemption.test.ts`~~ RESOLVED mid-session by #5272
- as-of: 2026-09-30; RESOLVED 2026-10-01 (was captured against PR #5273's base so the red would not be misattributed to #5273)
- **Symptom + exact repro (historical):** `Unit tests (1)` failed on `src/server/services/__tests__/model-file-hash-writer-exemption.test.ts` at base `e432c50817` on `main` itself (SHA-pinned check-runs: `failure`, 2026-10-01T00:21Z) and in #5273's shard: `Test Files 1 failed | 552 passed (553)`, `ELIFECYCLE Command failed with exit code 1`.
- **Ruled out: "caused by #5273"** — the base commit failed identically 24 min before the PR's run, and the failing file is unrelated to the PR's diff. `via: command`
- **RESOLVED:** `origin/main` head after this session's ff-merge is `14d7f9f957` — `test(model-file-hash): use the canonical env mock in the writer-exemption test (#5272)`, touching the exact failing file. `via: command`

## Next steps (ranked)
1. **Verify live silence after the next `main`→`release` cut** (civitai dp-prod). Once a release carrying `979b9439d8` is serving, push (or wait for fleet automation to push) to a canonical build repo and confirm NO red `Apps build-chain rejected` embed in the mod-alerts channel while `/apps/review` still shows the pending row. This is a **NEW arc** — the closing condition above was frozen at round 1 and is already met; do not re-open this doc's arc to hold it. forcing: none

## Defects (batched)
- ~~Main red on `Unit tests (1)` at base `e432c50817`~~ — RESOLVED mid-session by `#5272` (see the superseded investigation block above).

## Gotchas / decisions / dead-ends
- **Traefik Loki cannot count park-path pings:** the webhook 202s fast, and the access-log filter only writes `4xx/5xx OR >5s` — so `{namespace="traefik", log_type="access"} |= "git-push"` returns **matched-nothing over 72h** (verified) while pings demonstrably fire. The DB is the counter: push-originated rows are uniquely `coalesce(bundle_key,'')=''` (no MinIO bundle; `forgejo_commit_sha` NOT NULL does NOT discriminate — approve stamps it on ZIP rows too). Ping count ≥ row count: a re-delivery of the same sha re-pings while `recordPendingFromPush` only refreshes the existing row.
- **Shared-webhook disable options that were rejected:** zeroing `DISCORD_WEBHOOK_MOD_ALERTS` kills the 2 health-check producers; the `app-blocks-pipeline-enabled` Flipt kill-switch 503s the whole webhook (breaks the park flow, not just the ping). Code-level stage removal was the only selective fix.
- **civitai worktree recipe** (from its CLAUDE.md, followed this session): worktrees under `/home/zach/workspace/civit/worktrees/<name>`; `worktree add <wt> -b <branch> --no-track origin/main` (deleting a leftover `-b` branch first, or it refuses); `submodule update --init event-engine-common`; `printf 'use flake\n' > .envrc && direnv allow`; `corepack pnpm install --frozen-lockfile` ≈ 13s from the shared store. Tests: `--project 'unit*'` (never bare `unit` — silently skips the 6 `unit-native` files).
- **CI verdicts must be SHA-pinned:** a PR rollup read seconds after `gh pr create` is not a verdict (checks lag the push); `gh api repos/civitai/civitai/commits/<sha>/check-runs` with `completed_at` read is. Used here to attribute the red shard to the base commit rather than the PR.

- **An inherited red clears with `gh pr update-branch`, never `gh run rerun`.** A rerun replays the *event's pinned SHA*, so it re-runs the same already-red tree and cannot pick up a base fix. `update-branch` creates a new head commit, which is what re-triggers CI against the current base. Worked here: red at `a8bca8f8ea` → green at `de794068e9`, same diff.
- **Prove the red belongs to the base before touching the PR — one SHA-pinned read on the BASE-SIDE fix commit.** `gh api repos/civitai/civitai/commits/<sha>/check-runs` on the fix's own merge commit answers "is the shard actually fixed?" directly. Reading only the PR's rollup cannot: it shows red whether the cause is the PR or the base. The prior session inferred the fix from #5272's commit *title*; the control is one command and it is what turns the inference into evidence.
- **`gh pr view --json headRefOid` LAGS a branch write and reads as if nothing happened.** Immediately after a successful `gh pr update-branch` (`✓ PR branch updated`, rc 0), `gh pr view` still returned the OLD `headRefOid` and `mergeable/mergeStateStatus: UNKNOWN`. `git ls-remote <url> refs/heads/<branch>` returned the new head instantly. **Resolve a head SHA with `ls-remote`, then pin every check-run read to it** — a poll keyed on `gh pr view`'s SHA would have graded the new CI against the old commit's rollup, which is the stale-rollup trap in its hardest-to-see form (every state terminal, count above the floor, field parsed correctly, wrong commit).
- **Merge-verdict floor used here, reusable:** min 13 check-runs on the pinned SHA, every `conclusion` terminal (treat `null` as busy, never "settled"), `completed_at` read so a stale verdict is visible rather than merely plausible, and `skipped`/`neutral` counted as non-blocking only after naming WHICH check skipped and why.
- **No duplicate-work risk was assumed — it was swept.** All 64 open PRs in `civitai/civitai` enumerated; #5273 was the only one touching `src/pages/api/internal/blocks/git-push.ts` or `src/tests/api/internal/blocks/git-push.gate.test.ts`.
- **This repo is PUBLIC and `claudedocs/` is tracked in it** (its own `CLAUDE.md`: *"including `docs/`, `claudedocs/`, `.claude/skills/`, and every commit in history. Write all of it for strangers."*). Handoff docs for this arc are therefore world-readable — keep internal identifiers, cluster topology and channel/webhook identifiers out of future updates to this doc.

## How to verify
- **Merged (the closing condition):** `gh pr view 5273 --repo civitai/civitai --json state --jq .state` → `MERGED`. ✅ as of 2026-10-01T02:02:35Z.
- **Landed by CONTENT, not ancestry** (squash merge — ancestry is the wrong test):
  ```bash
  git -C $CIVITAI fetch origin main -q
  F=src/pages/api/internal/blocks/git-push.ts
  git -C $CIVITAI show origin/main:$F | grep -c "unreviewed-push'"          # expect 0
  git -C $CIVITAI show origin/main:$F | grep -c "notifyModsOfWebhookFailure({"  # expect 6
  ```
- **Local, from a worktree off `origin/main`:** `corepack pnpm exec vitest run --project 'unit*' src/tests/api/internal/blocks/git-push.gate.test.ts` — 3 tests: park path (fresh + re-delivery) never calls `fetch`; a manifest-validation failure still POSTs the mod-alerts embed (`title` contains `Apps build-chain rejected`). The third test is the reachability control — without it the two negatives could pass with `fetch` wired to nothing.
- **Live (NOT yet done, gated on the next release cut):** after a release built from `979b9439d8` is serving, any direct push to a canonical build repo must produce a pending row at `/apps/review` and NO mod-alerts embed.
