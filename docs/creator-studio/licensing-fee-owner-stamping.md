# Licensing-fee owner stamping — checklist

Tracks the backend work that lets Creator Studio read **per-model earnings** without a ClickHouse
`modelVersionId → ownerUserId` dictionary. The owner is stamped onto every `ResourceCompensation` row at
write time, so per-model reads become `GROUP BY ownerId`.

Distinct from [licensing.md](./licensing.md) (the `/licensing` bulk-editor UI). This doc is the
mini-endpoint → orchestrator → `ResourceCompensation` → ClickHouse-views chain.

## ClickUp tasks

- **[868kcq00g](https://app.clickup.com/t/8459928/868kcq00g)** — *(briant)* build MVs on `ResourceCompensation`
  aggregating earnings by user ID; remove the `modelVersionId → userId` dictionary. **Blocked on Koen's
  orchestrator change.**
- **[868kcpzzt](https://app.clickup.com/t/8459928/868kcpzzt)** — *(Koen)* orchestrator reads owner user IDs from the
  mini endpoint and persists them onto each `ResourceCompensation` write. **Blocked on the mini endpoint being live.**

## Settled model — flat lineage, single ancestor

Confirmed by Justin (conversation 2026-07-14):

> "you can't be a fine tune of anything except a base model/ecosystem" … "at most there can only be a single
> ancestor" … "there isn't really a hierarchy. It's just LoRa/Checkpoint → Ecosystem"

So **every resource has exactly one ancestor (its ecosystem/base)**. There is no chain to walk; `FineTune2`
(a fine-tune of a fine-tune) does not exist.

**Per-resource fees = own fee + single ecosystem fee ⇒ at most 2 fees per resource.** Multiplicity in a
generation comes from using multiple resources, not from lineage depth. Worked example (`Anima 5 / Finetune 1 /
Lora 0.1`):

| Resource generated with | `fees[]` emitted | Recipients |
|---|---|---|
| Finetune (checkpoint on Anima) | Anima **5** (`baseModel`) + Finetune **1** (`version`) | Anima owner, Finetune owner |
| LoRA (on Anima) | Anima **5** (`baseModel`) + LoRA **0.1** (`version`) | Anima owner, LoRA owner |

A generation using **both** yields `{Anima 5, Finetune 1}` + `{Anima 5, LoRA 0.1}`; the shared ecosystem fee
dedups to **Anima 5 + Finetune 1 + LoRA 0.1 = 3 fees, 3 recipients, from 2 resources.**

## Checklist

### Mini endpoint — main app (briant) ✅ shipped

`src/pages/api/v1/model-versions/mini/[id].ts`

- [x] Emit `recipientUserId` (owner `User.id`) on every `fees[]` entry — the top-level `modelUserId` plus the
      per-fee recipient owner, exactly what task 868kcpzzt consumes.
- [x] Resolve the single base/lineage recipient owner from the fee tiers: a version that is itself a
      `LicensingRoot` (a row in the `LicensingRoot` table) settles its own fee to its own `modelUserId`;
      otherwise `licensingSourceVersionId` settles to `sourceLicensingFeeRecipientUserId` (the parent root's
      owner). There is **no** `(baseModel, modelType)` fallback — a null parent on a non-root means no lineage
      fee. (The old `BaseModelLicensingFee` tier-3 rule was removed.)
- [x] No chain walk / recipient array needed — single ancestor is enforced at write time
      (`model-version.controller.ts` requires `licensingSourceVersionId` to be a `LicensingRoot` sharing the same
      base model), so the ≤2-fee `fees[]` block is complete.
- [x] Typecheck + commit — shipped as **PR #3139** (`afeabaa63e feat(licensing): expose owner user IDs on the
      mini endpoint`).
- [x] Deploy so the endpoint is live → unblocked 868kcpzzt.
- [x] On deploy, notify Koen (orchestrator) and Justin (backfill) — both downstream steps below are done, which
      confirms the endpoint went live.

### Orchestrator — Koen (868kcpzzt) ✅ deployed + backfilled

- [x] Fetch the top-level user ID + the per-fee `recipientUserId`s from the mini endpoint.
- [x] Write them to the `userId Int32 DEFAULT 0` column on `orchestration.resourceCompensations`.
- [x] Confirm the table engine — it's `SharedSummingMergeTree`, `ORDER BY (date, userId, modelVersionId,
      accountType, source)`, `PARTITION BY toYYYYMM(date)`. Consequence for readers: always `sum(amount)` +
      `GROUP BY` at read time; no `sumMerge` (plain summing engine, not aggregating).
- [ ] **Dedup the ecosystem fee to once per generation** — with the "only checkpoints/diffusion carry a parent
      fee" rule (Justin, flat lineage) and one base checkpoint per generation, the ecosystem fee appears once by
      construction; confirm no charge-time double-count remains. *(Product rule still to be encoded in the mini
      endpoint — see [licensing-lineage-parent-fee.md](./licensing-lineage-parent-fee.md).)*

### Backfill — Justin ✅ done

- [x] Add the nullable owner column to `resourceCompensations` (`userId Int32 DEFAULT 0`).
- [x] Run the historical backfill — **99.7% of rows attributed** (31.15M of 31.25M) back to 2024-08-01; the 0.3%
      at `userId = 0` are unmappable versions (deleted models) and fall out of any per-creator (`userId = X`) read.

### ClickHouse views — main app (briant, 868kcq00g) ✅ v1 reads built

- [x] Read per-model earnings by owner — `apps/creator-studio/src/lib/server/models-earnings.ts`
      (`getModelEarnings`): `WHERE userId = X … GROUP BY modelVersionId, accountType`, cached, Postgres-enriched
      for names/type. Wired into the dashboard "Top-earning model" tile and the `/analytics` per-model table.
      (A read-through cache is enough for v1; a summing MV can come later if the query gets hot.)
- [x] Remove the `modelVersionId → ownerUserId` dictionary approach — supersedes the CDC/ClickPipe mirror plan in
      the creator-studio monorepo's `cdc-koen.md`.
- [x] Corrupt-row filter on every read (`match(accountType,'^[A-Za-z]+$') AND amount > 0 AND amount < 1e12`).
- **Note:** `accountType` is Capitalized here (`Yellow`/`Blue`/`Green`/`CashSettled`) — unlike `buzzTransactions`'
  lowercase values — so readers lower-first it onto the shared currency vocabulary. `source` also includes a
  `compensation_recovered_*` variant, and `licenseFee` can settle to `CashSettled` (cash, not buzz).

## Attribution note

Because the owner is stamped **at write time**, ownership transfers resolve themselves: rows written after a model
changes hands carry the new owner, and past rows keep the prior owner. Point-in-time attribution, no retro-reassign.
