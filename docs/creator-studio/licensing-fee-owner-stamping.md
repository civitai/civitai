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

### Mini endpoint — main app (briant) ✅ code done, uncommitted

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
- [ ] Typecheck + commit (behind commit gate — commit only when asked).
- [ ] Deploy so the endpoint is live → unblocks 868kcpzzt.
- [ ] On deploy, notify Koen (orchestrator) and Justin (backfill).

### Orchestrator — Koen (868kcpzzt)

- [ ] Fetch the top-level user ID + the per-fee `recipientUserId`s from the mini endpoint.
- [ ] Write them to the new nullable owner-user-id column on `ResourceCompensation` (Justin adds the column,
      defaulting to null).
- [ ] **Dedup the ecosystem fee to once per generation** — a resource correctly emits its ecosystem fee, but two
      resources sharing an ecosystem must not double-charge it. Confirm this collapse happens at charge time.
- [ ] Confirm the `ResourceCompensation` table engine (plain / `SummingMergeTree` / other) — nobody on the call
      was sure; it affects how the owner column and the MVs behave.

### Backfill — Justin

- [ ] Add the nullable owner-user-id column to `ResourceCompensation`.
- [ ] Run the historical backfill; early rows stay null until it completes.

### ClickHouse views — main app (briant, 868kcq00g)

- [ ] Once the owner column is populated, build MVs aggregating earnings by user ID.
- [ ] Remove the `modelVersionId → ownerUserId` dictionary approach (supersedes the CDC/ClickPipe mirror plan in
      the creator-studio monorepo's `cdc-koen.md`).
- [ ] Keep the corrupt-row filter on any read of `ResourceCompensation` (garbage `accountType`/amount rows).

## Attribution note

Because the owner is stamped **at write time**, ownership transfers resolve themselves: rows written after a model
changes hands carry the new owner, and past rows keep the prior owner. Point-in-time attribution, no retro-reassign.
