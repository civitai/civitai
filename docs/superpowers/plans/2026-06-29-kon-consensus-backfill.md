# KoN Consensus Backfill

**Status:** Phase 1 shipped (PR #2828) and run to completion on 2026-06-30 — `remainingAutoResolvable: 0`.

One-time admin backfill that finalized the New-Order ("KoN") image-rating votes left stranded `Pending`/`Inconclusive` by the **2026-06-23 sysRedis wipe**, re-stamping the consensus-met ones to `Correct`/`Failed` so blessed-buzz pays out and the nightly `Inconclusive` purge stops.

## Background

The wipe destroyed the `new-order:ratings:<imageId>` weighted-consensus zsets. Re-seeding `new-order:config` (a different key) fixed the abuse/limiter thresholds but **not** consensus — images stopped resolving at the 5-vote mark, piled up, and got mass-purged `Inconclusive` at the 00:00 rotation. That single daily purge drove **both** prod symptoms: the KoN earnings drop (no `Correct` rows → no blessed buzz) and the "abuse detection" false positives (the 00:00 batch-stamp inflates `avgPerMinute`). The zsets recovered, but the backlog didn't self-heal — hence this backfill. See [[project_kon_abuse_detection_false_positives]] for the full investigation.

## How it works

- **Source of truth = the ClickHouse `knights_new_order_image_rating` ledger, NOT the Redis queue** (the `new-order:queues:*` zsets rotate/wipe and are useless as a record). Catches both still-`Pending` and already-purged-`Inconclusive` votes.
- **Consensus = raw vote agreement** (`voters >= 4` AND `topCount/voters >= minAgreement`, default 0.6) — a deliberate approximation of the live *weighted* algorithm (weights lived only in the wiped zsets); safe because most stranded images were unanimous.
- For each consensus image, re-insert its voter rows with `status = Correct/Failed` (per-voter vs the dominant rating) and `createdAt = run time`, then reset the affected players' `correctJudgments`/`allJudgments`/`fervor` counters so they lazily rebuild from CH. Buzz flows through the existing daily `new-order-grant-bless-buzz` job.
- **Phase 1 writes only** `same_level` / `down_1lvl` / `up_rate`. **Down-rates >1 NSFW level (`down_gt1`) are excluded** — they go to mod review per the live guard (`new-order.service.ts:500`). `unknown_orig` (no original level) also excluded.

## Files

- `src/server/games/new-order/consensus-backfill.ts` — `classifyDecision` (pure), `getConsensusCandidates`, `restampBatch`, `reconcileAffectedPlayers`, `countRestampedRows`.
- `src/server/games/new-order/__tests__/consensus-backfill.test.ts` — Vitest for `classifyDecision` (kept out of `src/pages` — the route-type validator fails `next build` on test files there).
- `src/pages/api/admin/temp/new-order-consensus-backfill.ts` — `WebhookEndpoint` GET route (the temp-admin-backfill convention).

## API

`GET /api/admin/temp/new-order-consensus-backfill?token=$WEBHOOK_TOKEN&action=<action>&...params`

| action | effect |
|---|---|
| `resolve` | **read-only preview** — `{ dryRun:true, totalCandidates, byDecision (all classes), wouldResolve (writable subset, post-limit), skipped:{down_gt1,unknown_orig} }` |
| `resolve&dryRun=false` | **the write** — re-stamps the write set; `{ dryRun:false, imagesTargeted, rowsResolved, usersReconciled, byDecision, stampISO }` |
| `verify` | `{ remainingAutoResolvable, remainingEscalate }` |

**Write gate:** read-only unless the literal `&dryRun=false` is present (`p.dryRun !== 'false'`). Omitted / any other value stays read-only — fail-safe by default. (A side-effecting GET, accepted because it's token-gated, idempotent, and the write needs the explicit literal.)

Params: `startDate` (def `2026-06-23 00:00:00`), `minAgreement` (def 0.6 — keep; 0.5 reintroduces domRating tie ambiguity), `staleHours` (def 12 — `Pending` newer than this is skipped so the drain never races the live resolver; `Inconclusive` always eligible), `limit`, `batchSize` (def 1000, max 5000), `concurrency` (def 4).

## Gotchas (for anyone touching the queries)

- **Use the `by_imageId` projection, not `FINAL`.** Table is `SharedReplacingMergeTree ORDER BY (userId, imageId)`, no partition, no version col. `imageId` isn't the leading key, so `FINAL ... WHERE imageId IN (...)` scans ~3958/6615 granules on the 54M-row table. The projection (`GROUP BY imageId, userId` + `argMax(col, createdAt)`, the same pattern as `updatePendingImageRatings`) serves `imageId IN` from ~7 granules and gives the schema's canonical "latest row" without `FINAL`.
- **Status-alias shadowing (this bit us — silent 0-row write).** The re-stamp `SELECT` redefines `status` via `if(...) AS status`; a trailing `WHERE status IN ('Pending','Inconclusive')` then binds to that (Correct/Failed) alias and matches nothing. Filter on the source `status` in an `eligible` CTE **before** the if-rewrite.
- **`createdAt` is stamped to run-time on purpose.** `grant-bless-buzz` (`new-order-jobs.ts:44`) pays `Correct/Failed` from *exactly 3 days ago*, so run-time stamping = payout at run-day + 3. Preserving original vote time would drop the rows outside the payout window forever.
- **Report actual rows, not candidate counts.** The write reports `rowsResolved` via `countRestampedRows` (`count() WHERE createdAt = stampISO AND status IN ('Correct','Failed')`) — a 0 surfaces a no-op. `imagesTargeted` is the attempted image count.

## Rollout (how it was run)

```
?action=resolve                                        # preview
?action=resolve&dryRun=false&limit=500&batchSize=250   # tiny write, then ?action=verify
?action=resolve&dryRun=false&limit=10000               # staged slices until verify ~ 0
```
The endpoint writes to whatever ClickHouse the deployed env points at — confirm that before a `dryRun=false` run. (During rollout, manuel's localhost app was writing to the live KoN CH.)

## Outcome (2026-06-30)

- `verify` → `remainingAutoResolvable: 0`, `remainingEscalate: 1876`.
- Re-stamped ~321K rows (282,075 `Correct` + 38,787 `Failed`) across ~68.7K images / ~605 users.
- `Inconclusive` back to ~2K/day (from the ~40K/day collapse) — consensus resolution restored.

## Follow-ups (not in PR #2828)

- **Warn mods** of the one-time abuse-detection blip on write day (all re-stamped rows share their run timestamps → minute buckets explode `avgPerMinute`).
- **Earnings spike** at run-day + 3: ~5 days of backlog (~28K+ buzz / ~605 users) lands in one `grant-bless-buzz` run — correct but anomalous-looking.
- **Phase 2:** the ~1,876 `down_gt1` → escalate to the Inquisitor queue (`addImageToQueue(..., 'Inquisitor', 1)`) vs leave `Inconclusive`; optionally apply NSFW levels for `down_1lvl`/`up_rate` images via `updateImageNsfwLevel` (heavier — Postgres + search reindex).
- **Standing metric fix:** preserve `orig.createdAt` through finalization (`new-order.service.ts:934`) so the abuse scan isn't garbage even when counters are healthy.
- **Investigate the recurring sysRedis `new-order:*` wipe** (~2026-05-14 and ~2026-06-23).
- Minor: zod `parsed.error.flatten()` deprecation in the endpoint.
