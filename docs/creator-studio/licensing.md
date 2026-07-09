# `/licensing` — Licensing fees (bulk editor)

> **v1 if it lands, else fast-follow** ([plan §8](../creator-studio-plan.md#8-phasing) — "bulk editing / default
> suggestions can trail the per-version editor"). The multi-version companion to [models.md](./models.md): set, clear,
> and default a **licensing fee** across MANY of the creator's versions in one pass. Ops in
> [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation).

## ⚠️ Open fork — separate page, or a mode of `/models`?

`/licensing` and [`/models`](./models.md) overlap almost completely: **same rows** (model versions), **same field**
(the per-version fee), **same write** (`setLicensingFee`). The plan lists them as separate pages but explicitly flags
this as unresolved ([plan §8](../creator-studio-plan.md#8-phasing), post-v1 "bulk … if not landed"). **Resolve before
building.** Options:

- **A — separate `/licensing` page** (as listed). Clean nav entry; a dedicated "bulk money" surface. Cost: two pages
  to keep in sync.
- **B — `?mode=bulk` on `/models`** — same route, the table swaps into a multi-select + bulk-bar mode via searchParam.
  Zero divergence; discoverable from where creators already are.
- **C — a tab within `/models`** ("Manage" / "Bulk fees") — one route, two view states, own tab.

**Whatever we pick, this is not a second implementation.** Both surfaces share the same **row component** and call
`setLicensingFee` (single) / `bulkSetLicensingFee` (many) from the one **monetization module** — see
[models.md § Actions](./models.md#actions-writes--form-actions--monetization-module). This doc specs the *bulk*
behaviour regardless of where it renders.

## User story

As a creator with many versions, I open the bulk editor, filter/search to the versions I care about, **multi-select**
rows (or select-all-matching), and in one action either **apply a fee**, **clear fees**, or **apply the model-type
default suggestion**. I confirm the change in a dialog (it's money) before it applies to every selected version.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`table`** (data-table) with a leading **`checkbox`** column — one row per version (the shared row from
  [models.md](./models.md)), plus a header select-all. Columns: version · base model · **model type** · current fee
  (`badge` for `Active` / `Paused` / `Off`).
- **Bulk action bar** — appears when ≥1 row selected: **`input`** (fee amount) + **`button`** *Apply fee*, *Clear
  fees*, and *Apply default by type*; a live count ("42 versions selected").
- **`dialog`** — confirm-before-apply summarizing the change ("Set 0.1 buzz/image on 42 versions — 8 already have a fee,
  overwrite?"); **`sonner`** toast for result; **`badge`** for per-row fee state.
- **`input`**/search + filter controls bound to URL searchParams (see reads).

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id` — same shape as
[models.md § Data](./models.md#data-reads--pageserverts):

- The creator's **models + versions** with current fee fields (`licensingFee`, `licensingFeeType`, the **`active`
  flag** — [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) and each version's **model type** (drives
  the default suggestion).
- The user's member **`tier`** (gates whether any fee write is enabled) —
  [plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices).
- **`getDefaultFeeSuggestions`** — model-type defaults (LoRA ~0.1, base ~1 buzz/image;
  [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).
- **Not** an analytics page — no ClickHouse. Table state (search / filters / sort / pagination) lives in **URL
  searchParams**.

Paginate/virtualize — the bulk case *is* the many-versions case.

## Actions (writes) — form actions → monetization module

The one bulk mutation goes through the creator-studio **monetization module** (`src/lib/server/monetization/`), writing
`ModelVersion` via kysely — **no buzz call, no ClickHouse**
([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run)):

| Action | Op | Notes |
|---|---|---|
| Apply fee to selected | `bulkSetLicensingFee(versionIds, fee)` | **member-only**; fractional (0.01 precision); validate bounds. Value kept even when paused. |
| Clear fees on selected | `bulkSetLicensingFee(versionIds, null)` | sets fee off across the selection. |
| Apply default by type | `bulkSetLicensingFee` per resolved default | resolve each version's default via `getDefaultFeeSuggestions`, then set. |

- **Authorization asserted inside the module** (member `tier`) for the whole batch — the disabled UI is UX, the server
  re-checks — and **ownership is checked per version**: the batch must confirm `locals.user.id` owns *every* id
  ([models.md § Actions](./models.md#actions-writes--form-actions--monetization-module)).
- **Stacking is not handled here** — the backend does it
  ([plan §7.3](../creator-studio-plan.md#73-fee-stacking--already-handled-no-new-work)).
- Optimistic money updates are OK with **rollback** on failure; a partial failure reports which ids failed.

## States

- **Loading** — skeleton rows.
- **Empty** — no models → empty state + link to upload on the main app (same as [models.md](./models.md)).
- **Nothing selected** — bulk bar hidden; table read-only.
- **Non-member** — page loads; the fee/apply/clear controls **disabled** with an upsell to `/join` (a fee is
  member-gated).
- **Fee paused** — versions whose owner's membership lapsed show `Paused`, value retained, not charged
  ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)).
- **Error / partial** — toast + inline row errors for the ids that failed; optimistic changes roll back.

## Gating

Member-`tier` gates **every** fee write here (there is no non-gated bulk action). Enforced in UI (disabled + tooltip)
and re-checked in the module for the whole batch. Exact bar (tier vs full-CP membership) pending
([plan §9](../creator-studio-plan.md#9-decisions--open-questions)).

## Shared / cross-refs

- **Shares the row component + `setLicensingFee` / `bulkSetLicensingFee`** with [models.md](./models.md) — this is the
  bulk surface over the same data, not a fork.
- Per-account default fee suggestions / settlement-currency default live in [settings.md](./settings.md).
- Nav item is member-aware (`memberOnly`) via the shared `nav.ts`.

## Open questions

- **Separate page vs mode of `/models`** — the fork above; decide before building (A / B / C).
- **Default-apply semantics** — apply to *selected only* or to *all of a chosen model type*? And **overwrite existing
  fees or only fill empty ones**? (Lean: selected-only + a confirm that names how many already have a fee.)
- **Selection across pages** — does a multi-select persist across paginated pages, or is "select all matching" a
  server-side filter apply (safer, no giant id list)? Should selection survive in URL state?
- **Scope of bulk** — fees only, or also bulk **access toggles** / sell-indefinitely? (Lean: fees-only for v1 — access
  is per-version on [models.md](./models.md).)
- **Guardrails against a mistaken overwrite** — mandatory confirm dialog with an affected-count + before/after summary;
  is an undo / recent-change surface warranted for a money field?
