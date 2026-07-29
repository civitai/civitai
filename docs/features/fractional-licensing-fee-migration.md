# Fractional licensing fee — migration runbook (A2)

Migrating `ModelVersion.licensingFee` from `Int` → `DECIMAL(10,2)` (0.01 buzz/image) using **expand / contract**
so it's safe under staged/rolling pod deploys — this infra never runs a migration + deploy atomically, so every
step is backward-compatible across the rollout window.

**Key design:** the Prisma field stays named `licensingFee` but `@map("licensingFeeAmount")` points it at a new
`DECIMAL` column. The old `licensingFee` `INTEGER` column is left untouched for old pods; a DB trigger keeps the
two in sync during the rollout window. Contract drops the old column + trigger. Phase 3 then renames the decimal
column to `licensingFee` and removes the `@map` — itself an expand/contract pair, since a bare `RENAME` isn't
rolling-safe either.

**Progress:** Phase 1 ✅ · Phase 2 ✅ · Phase 3a (rename-expand) ✅ merged · Phase 3b (rename-contract) — this tree, final drop.

---

## Phase 1 — Expand ✅ (merged + deployed)

### Apply the migration (manual — we do NOT run `prisma migrate deploy`)
- [x] Apply `prisma/migrations/20260709120000_model_version_licensing_fee_expand/migration.sql` before the code deploys.
- [x] Verify: `licensingFeeAmount` column exists; backfill complete; sync trigger exists; sync works both ways.

### Deploy the code
- [x] Ship the expand branch; confirm the whole fleet rolled over.
- [x] Smoke test: fractional fee persists/displays; generation charge returns it; model page shows it.

### Post-rollout verification (before contract)
- [x] No `Inconsistent column data` errors from old pods during the overlap window.
- [x] Columns stayed consistent; daily payout job produced sane license-fee totals.

---

## Phase 2 — Contract ✅ (migration applied manually)

### Migration SQL (applied manually)
`prisma/migrations/20260710120000_model_version_licensing_fee_contract/migration.sql` — drops the sync trigger +
function and the legacy Int `licensingFee` column (guarded with `lock_timeout`, idempotent).
- [x] Confirmed expand fully rolled out; confirmed no ClickPipe/CDC consumer depended on the old column.
- [x] Applied manually. No Prisma schema change / regeneration needed (field is `@map("licensingFeeAmount")`).
- [x] Verified: `\d "ModelVersion"` no longer shows the Int `licensingFee`; trigger/function gone; app reads/writes fees.

---

## Phase 3 — Rename (eliminate the `@map`)

Clean final schema: the decimal column should be named `licensingFee`, not `licensingFeeAmount` behind an
invisible `@map`. A bare `RENAME COLUMN` can't run under a rolling deploy, so the rename is itself an
expand/contract pair.

### 3a — Rename-expand ✅ (merged to main)
`…_licensing_fee_rename_expand/migration.sql` adds the target-named `licensingFee` decimal column, backfills it,
and installs a bidirectional **exact** sync trigger; the code drops the `@map` and repoints raw SQL to
`licensingFee`.
- [x] Apply the rename-expand migration before the code deploys (additive; old pods keep using `licensingFeeAmount`).
- [x] Ship the code (normal rolling deploy — no window). New pods use `licensingFee`; the trigger keeps both columns identical.
- [ ] Confirm the whole fleet rolled over and the two columns stay in sync (before running 3b).

### 3b — Rename-contract — `feat/fractional-licensing-fee-rename-contract`
`…_licensing_fee_rename_contract/migration.sql` drops the rename sync trigger + function and the now-unused
`licensingFeeAmount` column. Migration-only, no code change.
- [ ] Confirm 3a fully rolled out; confirm no ClickPipe/CDC consumer depends on `licensingFeeAmount`.
- [ ] Apply manually. **End state:** clean schema — field `licensingFee` → column `licensingFee`, no `@map`. **Migration complete.**

---

## Related follow-ups

- [ ] **Settlement rule** — `deliver-creator-compensation.ts` sums fractionally and `Math.floor`s the daily buzz total once; sub-buzz daily remainder forfeited. **Finance to confirm** floor vs round vs carry-over.
- [ ] **Orchestrator recording** — confirm the generation charge records the fractional per-image fee into `orchestration.resourceCompensations`.
- [ ] **zod precision guard** — `.int()` was dropped; consider `.multipleOf(0.01)` / server-side round so `0.123` isn't silently truncated.
- [ ] **creator-studio** — after the phase-3 rename the shared kysely field is `licensingFee` again, so its `src/lib/server/models.ts` read works with the original name (parse the `string` to a number). If it rebases between phases 1–2 and 3, the kysely field is temporarily `licensingFeeAmount`.
- [ ] **`MAX_LICENSING_FEE`** — confirm the cap (still 100) is right for fractional pricing.

---

## Rollback

- **Expand:** roll code back; old pods read the trigger-synced Int `licensingFee` (loses only sub-buzz precision). Optionally drop the added column/trigger.
- **Contract:** irreversible (Int column gone). Only run once expand is proven. ✅ done
- **Rename-expand (3a):** roll the code back; the previous release keeps using `licensingFeeAmount` (kept current by the trigger). Optionally drop the added `licensingFee` column + rename trigger.
- **Rename-contract (3b):** irreversible (`licensingFeeAmount` gone). Only run once 3a is proven.
