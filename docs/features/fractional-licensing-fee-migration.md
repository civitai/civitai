# Fractional licensing fee — migration runbook (A2)

Migrating `ModelVersion.licensingFee` from `Int` → `DECIMAL(10,2)` (0.01 buzz/image) using **expand / contract**
so it's safe under staged/rolling pod deploys. This branch ships the **expand** phase. This doc is the checklist
to **complete** the migration after it rolls out.

**Key design:** the Prisma field stays named `licensingFee` but `@map("licensingFeeAmount")` points it at a new
`DECIMAL` column. The old `licensingFee` `INTEGER` column is left untouched for old pods; a DB trigger keeps the
two in sync during the rollout window. Contract phase later drops the old column + trigger.

---

## Phase 1 — Expand (this branch)

### Apply the migration (manual — we do NOT run `prisma migrate deploy`)
- [ ] Decide target env(s): preview → staging → prod. Apply the SQL from
      `prisma/migrations/20260709120000_model_version_licensing_fee_expand/migration.sql` **before** the code deploys.
- [ ] After applying, verify in that DB:
  - [ ] `licensingFeeAmount` column exists: `\d "ModelVersion"` shows `numeric(10,2)`.
  - [ ] Backfill is complete: `SELECT count(*) FROM "ModelVersion" WHERE "licensingFee" IS NOT NULL AND "licensingFeeAmount" IS NULL;` → **0**.
  - [ ] Trigger exists: `SELECT tgname FROM pg_trigger WHERE tgrelid = '"ModelVersion"'::regclass AND tgname = 'modelVersionLicensingFeeSync';` → 1 row.
  - [ ] Sync works both ways (on a throwaway row): set `licensingFeeAmount = 0.10` → `licensingFee` becomes `0`; set `licensingFee = 3` → `licensingFeeAmount` becomes `3.00`.

### Deploy the code
- [ ] Ship this branch. Confirm the **whole fleet** has rolled over (no old pods) before relying on fractional values.
- [ ] Smoke test on new pods:
  - [ ] Set a fractional fee (e.g. `0.10`) via the model-version form → persists and displays as `0.10`.
  - [ ] Generation charge (`/api/v1/model-versions/mini/[id]`) returns the fractional fee in the distribution.
  - [ ] Model page + generation resource badge show the fee (not rounded to 0).

### Post-rollout verification (before contract)
- [ ] No errors in old pods during the overlap window (watch logs for Prisma `Inconsistent column data` on `ModelVersion` — should be none, since old pods read the untouched Int column).
- [ ] Columns stay consistent: `SELECT count(*) FROM "ModelVersion" WHERE "licensingFeeAmount" IS DISTINCT FROM ROUND("licensingFeeAmount") ... ` spot-check, and confirm no row has `licensingFee` out of sync with `ROUND(licensingFeeAmount)`.
- [ ] Daily payout job (`deliver-creator-compensation`) ran and produced sane license-fee totals (see the settlement decision below).

---

## Phase 2 — Contract (a SEPARATE, later PR — only after Phase 1 is 100% rolled out and stable)

> Do **not** start until you're certain no old (Int-client) pods remain anywhere that reads `ModelVersion`.

### Migration SQL (new migration dir, applied manually)
```sql
-- Contract: drop the sync trigger + the legacy Int column. New code already reads/writes licensingFeeAmount.
DROP TRIGGER IF EXISTS "modelVersionLicensingFeeSync" ON "ModelVersion";
DROP FUNCTION IF EXISTS "syncModelVersionLicensingFee"();
ALTER TABLE "ModelVersion" DROP COLUMN "licensingFee";
```
- [ ] Apply to each env after that env's fleet is fully on the expand code.
- [ ] No Prisma schema change is required for the drop — the field is already `@map("licensingFeeAmount")`, and Prisma ignores the (now dropped) extra physical column.
- [ ] Verify: `\d "ModelVersion"` no longer shows the Int `licensingFee`; the trigger/function are gone; app still reads/writes fees.

### Optional cosmetic cleanup (later, low priority)
Only if you want the physical column named `licensingFee` again and the `@map` removed:
- [ ] In a maintenance window (or as its own expand/contract), `ALTER TABLE "ModelVersion" RENAME COLUMN "licensingFeeAmount" TO "licensingFee";` **and** in the same deploy remove `@map("licensingFeeAmount")` from the schema + regenerate. Do NOT rename while pods are rolling. Skipping this is fine — the `@map` can stay indefinitely.

---

## Related follow-ups (not blockers for expand, but part of "done")

- [ ] **Settlement rule** — `src/server/jobs/deliver-creator-compensation.ts` now sums fees fractionally (the ClickHouse query no longer floors per row) and `Math.floor`s the **daily** buzz total once. Sub-buzz daily remainder is forfeited. **Finance to confirm** floor vs round vs carry-over.
- [ ] **Orchestrator recording** — confirm the generation charge records the fractional per-image fee into `orchestration.resourceCompensations` (the daily settlement assumes fractional sums). This is upstream of this repo.
- [ ] **zod precision guard** — `.int()` was dropped from `licensingFee` in `model-version.schema.ts`; the DB rounds to 0.01 on write, but consider `.multipleOf(0.01)` / server-side round so `0.123` isn't silently truncated.
- [ ] **creator-studio** — its kysely read of the fee must move from `licensingFee` to the mapped column name `licensingFeeAmount` (the kysely type follows the physical column). Update on the `creator-studio-implementation` branch's `src/lib/server/models.ts` and parse the `string` to a number.
- [ ] **`MAX_LICENSING_FEE`** — confirm the cap (still 100) is right for fractional pricing (B6 says keep 100).

---

## Rollback

- **Expand, before code deploy:** the added column + trigger are inert to old code; safe to leave, or
  `DROP TRIGGER ...; DROP FUNCTION ...; ALTER TABLE "ModelVersion" DROP COLUMN "licensingFeeAmount";` to fully revert.
- **Expand, after code deploy:** roll the code back to the previous release. Old code reads the Int `licensingFee`,
  which the trigger kept current — so a rollback loses only sub-buzz precision on any fees set while new code was
  live (they read back as the rounded Int). Then optionally drop the column/trigger as above.
- **Contract:** irreversible (the Int column is gone). Only run once expand is proven.
