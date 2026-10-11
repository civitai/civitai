# Handoff: users-over-time-panel — MOVED

🔴 **This handoff now lives in `talos-infra`, not here:**
`<talos-infra>/claudedocs/handoff-users-over-time-panel.md`
(`civitai/talos-infra`, on `trunk` — committed 2026-09-28 as `21eb93c9c`).

Do not re-create it in this repo. A second copy is how the arc's record went stale
once already: the version at this path described the job as "armed, unobserved"
for two days after it had been running hourly.

## Why it moved
The work shipped across both repos, but every REMAINING item is talos-infra-side —
the staleness alert (`civitai/talos-infra#1645`), the unverified Grafana panel
render, and the hourly-table backfill. A handoff in the repo you cannot act from is
a doc nobody opens.

## What landed in THIS repo, for anyone arriving from a civitai-side search
- `src/server/clickhouse/migrations/2026-09-25-user-population-snapshot.sql` — the
  design, the preflights, the backfill arms and the reconciliation queries. Read this
  one before touching any of it; it carries the reasoning, in this codebase's idiom.
- `src/server/jobs/user-population-snapshot.ts` — the hourly job, `15 * * * *`,
  `LOOKBACK_HOURS = 3`.
- `src/server/jobs/user-population-snapshot.sql.ts` — pure SQL builders, no imports.
- `src/server/jobs/__tests__/user-population-snapshot.sql.test.ts`
- Registered in `src/pages/api/webhooks/run-jobs/[[...run]].ts`.

Shipped as **#5159**, merged 2026-09-26, released `eb57472dbe`.

🔴 **Two traps that live on this side of the line**, repeated here because the moved
doc is one repo away:
- **NEVER add a Kubernetes CronJob for a civitai job.** The scheduler auto-registers
  every name `get-jobs` serves. A CronJob is a second, duplicate trigger —
  `rewards-daily-reset`, `announcement-media-check` and `reap-dev-tunnels` each ran
  TWICE per tick until theirs were removed, and Redis locks do not reliably dedupe.
- **Merging `main` does NOT deploy.** dp-prod serves an image built from `release`.
