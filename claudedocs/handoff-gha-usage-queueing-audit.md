# Handoff: gha-usage-queueing-audit — 2026-10-29

## Run this first — the index, one command
```bash
$DEVRC/scripts/cairn-ops/read.sh recall --repo "$HOME/workspace/civit/civitai"
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading. `scope-absent`/`scope-empty` means nothing is recorded yet: ordinary, not
an error. Non-blocking: if it exits non-zero, print the stderr line and carry on.

## Goal
Audit what consumes the civitai org's GitHub Actions usage and what causes job
queueing; produce a ranked remediation shortlist. The operator's complaint that
motivated this: usage is high and jobs queue.
- **closing-condition:** `check` — re-run the attribution in "How to verify" for a
  busy day AFTER a chosen remediation ships; the arc CLOSES when either (a) Lint's
  share of the monorepo's hosted job-minutes is below 50%, or (b) a busy day's peak
  hosted concurrency stays ≤15 (the 20-job cap no longer saturated). Verdict
  ADDRESSED ⇒ arc CLOSED · NOT ⇒ name the one item still blocking.

## State now
- Audit COMPLETE this session (2026-10-29). No code changes anywhere; read-only
  against the GitHub API. Raw pulls live in `/tmp/opencode/gha-audit/` (tmp — may
  be gone; everything is re-derivable with the "How to verify" commands).
- Session belongs to NO clawgate task (`clawgate_handoff.sh resolve` exit 5,
  NOTHING RESOLVED — 0 tasks worked this session). No `clawgate-task:` field.
- **Org shape:** GitHub **Free** plan, 11 seats. Public repos = unlimited free
  hosted minutes; private repos share 2,000 min/mo; **the whole org shares ONE
  20-concurrent-job cap** for standard hosted runners (docs + measured).
- **October usage (~428k job-min total):** civitai monorepo 377,151 (88%) ·
  civitai-app-starters 28,384 · civitai-developer-docs 7,053 · cli 6,833 ·
  civ-hq 6,064 (private, BILLED) · flipt-state 553 (private) · game-frame 410
  (private) · ~40 other repos ~2,500 combined.
- **Cost so far ≈ $31 net this month**, all private-repo minutes past the
  included quota: the 2,000 free minutes ran out ~Oct 11, billed since at the
  observed $0.006/min (gross shows the same rate; GitHub's list price for Linux
  is $0.008 — the discount's source was not investigated).
- **The monorepo's usage is ~95% ONE workflow — `Lint`** (measured job-level over
  ALL runs: Oct 28 = 17,356 of 18,287 hosted job-min; past-24h Oct 28 16:00Z→
  Oct 29 16:10Z = 21,465 of 22,677 = 94.7%). Lint: ~438 runs/24h, ~11–12 jobs/run
  (4 unit shards, 2 component-test jobs, app-unit, app-typecheck, eslint-changed,
  geometry, package-unit, typecheck-gate), ~80 billed job-min per successful run,
  wall-clock p50 24 min / p99 88 min. Windows dev-env smoke ≈ 4% (~950 min/day).
- **Queueing cause = the 20-job cap, saturated around the clock:** Oct 28 peak
  concurrency = exactly 20, pinned at 19–20 for ~4,900 runner-minutes, including
  02:00 UTC (scheduled/renovate traffic). Job waits (run-created → job-started,
  which includes ~4 min of legitimate setup-DAG wait): p50 ≈ 12 min, p90 ≈ 43 min,
  max ≈ 85 min; ~64% of hosted jobs waited >5 min. 6 Lint runs were queued live at
  observation time. The monorepo ALONE saturates the cap; satellites add noise.
- **This week's optimizations landed on the satellites only:** daily billed min —
  developer-docs 200–270 → ~8/day (−96%; "cancel superseded PR/push runs per ref"
  #252, Oct 24), app-starters ~950–1,200 → ~110–340/day, cli ~100–240 → ~21–34/day.
  Those three were only ~12% of org usage; the monorepo is UNCHANGED — Lint
  per-run cost is flat at ~80 job-min, and this week's lint.yml commits were minor
  (job quarantine #7119, config-trigger linting #7038, both Oct 28).
- **Self-hosted fleet is unused:** org-level runners = 0; a `dp-runners` runner
  group and an `la-runners` label exist (lint.yml's matrix comment references
  them) but carried 13 jobs / 9 minutes ALL month. `civitai/actions-runner-smoke`
  exists as a proof repo (not read this session). This is the big idle lever.
- **Monorepo demand is GROWING:** daily billed minutes went 4.2k (Oct 1) → ~20k/day
  (late Oct), ~5× in a month.
- Cancelled jobs still bill until cancel: 1,461 min on Oct 28 (358 of the last
  1,000 monorepo runs cancelled — `cancel-in-progress` works and is worth its cost).

## Next steps (ranked)
1. Operator DECISION on the remediation path, then implement. Recommended: stand
   up self-hosted runners on the homelab for the monorepo's heavy Lint jobs
   (unit shards + component tests first) — self-hosted minutes on public repos are
   free, bypass the 20-job cap, and the `dp-runners` group + `la-runners` label
   already exist; `actions-runner-smoke` is the prior proof. Repo:
   `~/workspace/civit/civitai` (`.github/workflows/lint.yml`) + talos-infra side
   for the runner deployment.
   - forcing: none — the operator asked for the AUDIT, not the fix; the decision
     is theirs and is the gating item for everything below.
2. If self-hosted is declined: trim Lint fan-out in
   `~/workspace/civit/civitai/.github/workflows/lint.yml` — collapse the 2
   component-test jobs into the shard matrix, audit whether renovate branch
   pushes re-trigger the full fan-out, confirm path-filters cover push-to-main.
   Expected: tens of percent of Lint's ~20k min/day, and queue relief only if the
   peak job count drops below ~20.
   - forcing: none — same pending operator decision.
3. If staying fully hosted: GitHub Team (~$44/mo at 11 seats) buys 60 concurrent
   jobs (queue waits ~3× better) + 3,000 private min/mo (stops the civ-hq
   overspend that has been billing since ~Oct 11).
   - forcing: none — pending operator decision.
4. Housekeeping: `flipt-state` runs `validate` 29×/day at ~0.3 min/run — cheap
   but consolidatable to a cron/schedule. No queue impact.
   - forcing: none.

## Defects (batched)
- None — read-only audit; no code was changed or reviewed for defects.

## Gotchas / decisions / dead-ends
- 🔴 **Billing minutes are JOB-minutes, not run-minutes.** Summing run durations
  undercounts the monorepo ~7× (matrix fan-out bills each job separately). Use
  the billing usage API for totals and the jobs API for attribution; never mix.
- 🔴 **Skipped jobs carry bogus timestamps** (`runner_group_name` null,
  `started_at`==`completed_at` or completed<started ⇒ negative/absurd durations).
  A totals script that doesn't filter (`runner_group_name=='GitHub Actions'` AND
  duration>0) inflates Oct 28 from 18.3k true hosted minutes to 33k (~+80%).
  This poisoned my first attribution pass; the corrected filter is in "How to verify".
- 🔴 **`gh api --paginate` silently stopped at ~1000 runs** (11 pages) despite
  `total_count: 40000`; created-filtered `total_count` values are capped/rounded
  (2500 twice). ALWAYS verify a sample's actual date span before extrapolating —
  my first per-workflow estimate was ~7× low because 1,000 "recent" runs covered
  only Oct 27–29.
- **Job `created_at` is run-creation time for every job in a run** — job-level
  "wait" (started−created) includes legitimate DAG wait (~4 min for Lint's setup
  job). Report it as "wait incl. setup DAG"; true runner-queue wait is a few
  minutes less on p50.
- **Billing endpoint moved:** `/orgs/{org}/settings/billing/actions` → HTTP 410.
  Use `GET /organizations/{org}/settings/billing/usage?year=&month=` (paginated,
  `usageItems[]`). Storage SKU rows (`Actions storage`, GBh) are noise (pennies).
- **Free-plan facts (docs + measured):** 20 concurrent jobs org-wide (repos do
  NOT each get 20); public repos = unlimited free minutes; private = 2,000 min/mo
  included; single jobs cap at 6 h; larger hosted runners require a paid plan.
- **Runners count toward the cap only when hosted:** peak-concurrency histograms
  must count only `runner_group_name=='GitHub Actions'` — the 13 `dp-runners`
  (self-hosted) jobs and null-group skipped jobs don't consume hosted slots.
- `claudedocs/runner-scouting-2026-08-15.md` is about vitest/bun TEST runners,
  NOT GitHub Actions runners — do not cite it as prior art for self-hosted CI.
- Windows usage appears in the billing API as raw minutes (no 2× multiplier in
  the `quantity`; the 2× shows up in price if ever billed).

## How to verify
```bash
mkdir -p /tmp/opencode/gha-audit && cd /tmp/opencode/gha-audit
# org monthly usage by repo/SKU (the source of truth for totals)
gh api --paginate "/organizations/civitai/settings/billing/usage?year=2026&month=10" --slurp > usage-oct.json
# per-workflow attribution for one full day (monorepo): runs then jobs
gh api --paginate "repos/civitai/civitai/actions/runs?created=2026-10-28..2026-10-28&per_page=100" --slurp > day28-civitai.json
# per run: gh api repos/civitai/civitai/actions/runs/<id>/jobs?per_page=100
#   count only jobs with runner_group_name=='GitHub Actions' AND (completed-started)>0
# live queue check (was 6 queued Lint runs at audit time)
gh api "repos/civitai/civitai/actions/runs?status=queued&per_page=5" --jq '.total_count'
```
Closing-condition check: after a remediation ships, re-run the attribution for a
recent busy day and compute Lint's share + peak concurrency. Lint <50% share, or
peak ≤15 through a busy day ⇒ ADDRESSED (arc closes). Anything else ⇒ the one
blocker is whichever lever was not pulled.
