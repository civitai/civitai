# Licensing fees (bulk editor) — a mode of `/models`

> **v1 — critical** (managing your models is the point of v1). The bulk fee editor is **not a separate `/licensing`
> page** — it lives **inside [`/models`](./models.md)** as a bulk-edit column/mode: set, clear, and default a
> **licensing fee** across MANY of the creator's versions in one pass. Ops in
> [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation).
> This doc specs the *bulk* behaviour that renders inside `/models`.

## Where it lives — a bulk-edit mode of `/models` (resolved)

`/licensing` and [`/models`](./models.md) overlap almost completely: **same rows** (model versions), **same field**
(the per-version fee), **same write** (`setLicensingFee`). **Decision (LIC-1 / README-1):** there is **no separate
`/licensing` page** — the bulk editor is a **bulk-edit column/mode inside `/models`** (multi-select + a fee column you
can set across the selection). Zero divergence, and it's discoverable from where creators already manage models.

Both the single and bulk paths share the same **row component** and call `setLicensingFee` (single) /
`bulkSetLicensingFee` (many) from the one **monetization module** — see
[models.md § Actions](./models.md#actions-writes--form-actions--monetization-module).

## User story

As a creator with many versions, I open the bulk editor, filter/search to the versions I care about, **multi-select**
rows (or select-all-matching), and in one action either **apply a fee**, **clear fees**, or **apply the model-type
default suggestion**. I confirm the change in a dialog (it's money) before it applies to every selected version.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`table`** (data-table) with a leading **`checkbox`** column — one row per version (the shared row from
  [models.md](./models.md)), plus a header select-all. Columns: version · base model · **model type** · current fee
  (`badge` for `Active` / `Paused` / `Off`) · **reference price** (the ecosystem's base generation cost) · **end-user
  price** (base cost + the licensing fee). The reference/end-user columns are **hardcoded for v1** (pulled from the
  orchestrator in v2 — Koen follow-up); when the ecosystem isn't defined, show **no reference price**.
- **Bulk action bar** — appears when ≥1 row selected: **`input`** (fee amount) + **`button`** *Apply fee*, *Clear
  fees*, and *Apply default by type*; a live count ("42 versions selected"). Applies to the **selected rows only**.
- **`dialog`** — mandatory confirm-before-apply on every bulk op, summarizing the change with an affected-count ("Set
  0.1 buzz/image on 42 versions — 8 already have a fee, overwrite?"); **`sonner`** toast for result; **`badge`** for
  per-row fee state. **No undo**, but changes are captured in an **audit log**.
- **`input`**/search + **filter controls** (base model · model type · date) bound to URL searchParams (see reads).

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id` — same shape as
[models.md § Data](./models.md#data-reads--pageserverts):

- The creator's **models + versions** with current fee fields (`licensingFee`, `licensingFeeType`, the **`active`
  flag** — [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) and each version's **model type** (drives
  the default suggestion).
- The user's **Creator Program membership** (gates whether any fee write is enabled) —
  [plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices).
- **`getDefaultFeeSuggestions`** — model-type defaults (LoRA ~0.1, base ~1 buzz/image;
  [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).
- **Not** an analytics page — no ClickHouse. Table state (search / filters / sort / pagination) lives in **URL
  searchParams**.

Paginate/virtualize (cursor-based, matching [models.md](./models.md)) — the bulk case *is* the many-versions case.
**Select-all-matching** spans every page: it fires a **server-side request that returns the matching version IDs** so the
selection stays consistent as the creator scrolls through pages.

## Actions (writes) — form actions → monetization module

The one bulk mutation goes through the creator-studio **monetization module** (`src/lib/server/monetization/`), writing
`ModelVersion` via kysely — **no buzz call, no ClickHouse**
([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run)):

| Action | Op | Notes |
|---|---|---|
| Apply fee to selected | `bulkSetLicensingFee(versionIds, fee)` | **Creator Program members only**; fractional (0.01 precision); floor 0.01, cap 100 buzz/image; validate bounds. Value kept even when paused. |
| Clear fees on selected | `bulkSetLicensingFee(versionIds, null)` | sets fee off across the selection. |
| Apply default by type | `bulkSetLicensingFee` per resolved default | resolve each version's default via `getDefaultFeeSuggestions`, then set. |

- **Authorization asserted inside the module** (Creator Program membership) for the whole batch — the disabled UI is UX,
  the server re-checks — and **ownership is checked per version**: the batch must confirm `locals.user.id` owns *every*
  id ([models.md § Actions](./models.md#actions-writes--form-actions--monetization-module)).
- **Stacking is not handled here** — the backend does it
  ([plan §7.3](../creator-studio-plan.md#73-fee-stacking--already-handled-no-new-work)).
- Optimistic money updates are OK with **rollback** on failure; a partial failure reports which ids failed.

## States

- **Loading** — skeleton rows.
- **Empty** — no models → empty state + link to upload on the main app (same as [models.md](./models.md)).
- **Nothing selected** — bulk bar hidden; table read-only.
- **Non-member** — page loads; the fee/apply/clear controls **disabled** with an upsell to `/join` (a fee is gated on
  Creator Program membership).
- **Fee paused** — versions whose owner's membership lapsed show `Paused`, value retained, not charged
  ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)).
- **Error / partial** — toast + inline row errors for the ids that failed; optimistic changes roll back.

## Gating

**Creator Program membership** gates **every** fee write here (there is no non-gated bulk action). Enforced in UI
(disabled + tooltip) and re-checked in the module for the whole batch.

## Shared / cross-refs

- **Shares the row component + `setLicensingFee` / `bulkSetLicensingFee`** with [models.md](./models.md) — this is the
  bulk surface over the same data, not a fork.
- Per-account default fee suggestions / settlement-currency default live in [settings.md](./settings.md).
- Nav item is member-aware (`memberOnly`) via the shared `nav.ts`.

## Decisions (resolved 2026-07-02)

- **LIC-1 — Where it lives.** No separate `/licensing` page. The bulk editor is a **bulk-edit column/mode inside
  `/models`** (see the resolved section above).
- **LIC-2 — Apply semantics + filters.** Apply to the **selected rows only** (creators filter + multi-select to target
  a set). Filters mirror the main site: **base model, model type, and a date filter** (e.g. "everything released in the
  last 30 days"). Show a **reference price** (ecosystem base cost) and an **end-user price** column (base cost + fee) so
  creators see how their pricing fits; the reference is **hardcoded for v1**, pulled from the orchestrator in v2
  (backend follow-up, tracked internally); **no reference shown when the ecosystem is
  undefined**.
- **LIC-3 — Selection across pages.** "Select all matching" spans every page via a **server-side request that returns
  the matching version IDs**, so the selection stays consistent as the creator pages through.
- **LIC-4 — Scope of bulk.** **Fees only for v1**, but design so other bulk ops (access permissions, sell rates) can be
  added later — creators will want "all my old models at rate X, new ones at rate Y."
- **LIC-5 — Guardrails.** Every bulk op requires a **confirm dialog with an affected-count**. **No undo**, but keep an
  **audit log** of the changes made and when.

**Still open / deferred:** **per-account default pricing settings** (a saved default licensing/access price for new
models) is **post-v1**, not v1. Pulling the reference price from the orchestrator (rather than hardcoding) is a v2
backend follow-up (tracked internally).
