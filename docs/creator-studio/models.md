# `/models` — Model management ⭐

> **v1 priority.** The creator's control surface for monetizing their own model versions: early/paid-access toggles,
> per-version licensing fee (members only), and "sell access indefinitely." Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1),
> ops in [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation).

## User story

As a creator, I open `/models` and see **my** models as rows with their **versions nested underneath** (drafts
included). Per version I manage **all monetization**: set/clear a **licensing fee** (members only), edit **early/paid
access** config, and — as a **Creator Program member** — make a version **available for sale indefinitely** (beyond
early access). I can also **publish or schedule a version's publish date** from here (v1 — managing your models is the
point). Changes save inline; I see immediately whether a fee is *active* or paused.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`table`** (data-table) — **grouped by model, versions nested** (expandable model rows; confirmed by Justin),
  **drafts included**. Per-version columns: version name · base model · publish status · **licensing fee** (input +
  on/off) · **access** (badge + edit) · indefinite-sale.
- **`input`** (numeric) for the fee amount; **`checkbox`**/switch for on-off and "sell indefinitely"; **`badge`** for
  fee state (`Active` / `Paused — no membership` / `Off`) and access state.
- **`tooltip`** for the paused/gated explanations; **`sonner`** (toast) for save success/failure.
- Member-gated controls render **disabled with an upsell tooltip** for non-members (link to `/join`).

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id`:

- The creator's **models + versions incl. drafts** with: publish status / `publishedAt`, `licensingFee` +
  `licensingFeeType` + the new **`active` flag** ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)),
  `earlyAccessConfig` / `earlyAccessEndsAt`, and the "unlimited access / indefinite-sale" flag.
  `licensingFeeSettlementCurrency` is read **for display only** — creators can't set it (see Actions).
- The user's **Creator Program membership** status — the single gate for **all** monetization actions (both the fee and
  indefinite-sale) — via `creatorProgram.getCreatorRequirements`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **Not** an analytics page — no ClickHouse here. Per-model earnings/usage live on [analytics.md](analytics.md).

## Actions (writes) — form actions → monetization module

All mutations go through the creator-studio **monetization module** (`src/lib/server/monetization/`), which writes
`ModelVersion` via kysely — **no buzz call, no ClickHouse** ([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run)):

| Action | Op | Notes |
|---|---|---|
| Set / adjust / clear licensing fee | `setLicensingFee(versionId, fee)` | **Creator Program members only**; fractional (0.01 precision); floor 0.01, cap 100 buzz/image; validate bounds. Value kept even when paused. |
| Edit early/paid access config | (access config write) | **Full** `earlyAccessConfig` brought over (not just a toggle) — Justin wants *all monetization in the studio*. Only the **generation price** field is a candidate for retirement (licensing fees now cover it). |
| Sell access indefinitely | `setUnlimitedAccess(versionId)` | **Creator Program members only** — early-access pricing with **no end date** (same mechanism, one just has no early-access end); needs main-app support ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)). |
| Publish / schedule publish | (publish write) | **v1 — critical.** Publish a version or set its publish date from the studio; managing your models is the point of v1. |

- **Authorization asserted inside the module** (disabled control is UX; the server re-checks): **all** monetization
  writes (fee, indefinite-sale) gate on **Creator Program membership** — one bar.
- **Ownership check**: every action confirms `locals.user.id` owns the version.
- **Settlement currency is not a creator choice** — cash settlement is done by Civitai only, in special circumstances,
  on the creator's behalf (Justin). No per-version or per-account control.
- **Stacking is not handled here** — the backend does it ([plan §7.3](../creator-studio-plan.md#73-fee-stacking--already-handled-no-new-work)).

## States

- **Loading** — skeleton rows (`skeleton`).
- **Empty** — creator has no models → friendly empty state + link to upload on the main app.
- **Non-member** — page loads; **fee** and **sell-indefinitely** controls disabled (Creator Program membership gate)
  with an upsell to `/join`; access-config editing stays available (early access isn't member-gated). Drafts are
  listed with a draft badge.
- **Fee paused** — member set a fee then membership lapsed → fee shows `Paused`, value retained, not charged
  ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)). Pre-cutover fees show a "not-yet-payable" state.
- **Error** — inline row error + toast; optimistic update rolls back on failure.

## Gating

Gating is a **single bar**: **Creator Program membership** gates every monetization action (setting a fee,
sell-indefinitely). Everything else (access config, publish) is open to any authenticated owner. Enforced in UI
(disabled + tooltip) and re-checked in the module.

## Shared / cross-refs

- Fee-setting also exists **inline on the main app** (`ModelVersionUpsertForm`) until model management is deprecated
  there ([plan §6.2](../creator-studio-plan.md#62-redirect-superseded-management-surfaces)) — same module at consolidation.
- Bulk fee editing across many versions is [licensing.md](licensing.md).
- Nav item is member-aware (`memberOnly`) via the shared `nav.ts`.

## Routing & URL state

- **Table state in the URL** — search (`?q=`), filters (`?status=`, `?fee=active|paused|off`, `?access=`), sort, cursor —
  read in `+page.server.ts` `load`, updated via `goto('?…', { keepFocus, noScroll })`; deep-linkable, refetches fresh.
- **Grouped rows** — which models are expanded is view state; keep ephemeral (or `?open=<modelId>` for linkable expansion).
- **Edit surfaces** — richer per-version editors (full access config, publish scheduling) open as a **URL-addressable
  drawer** (`?version=<id>`) via **shallow routing** (`pushState`) — linkable, back-button closes it, no page reload.
  Inline fee/on-off stays in the row.
- **Optimistic** money updates with rollback on failure (confirmed OK — the fee is a stored value, not a live charge).
- **Pagination** — **cursor-based virtualized infinite scroll** (load-more) with a total count shown, plus
  filters/sort/search; **not** numbered pages (see Decisions).

## Decisions (resolved 2026-07-02)

- **MODELS-1 — Fee gate.** **Creator Program membership** — one bar for all gated actions (fee-setting and
  indefinite-sale). No separate tier gate.
- **MODELS-2 — Access-config depth.** Bring over the **full** `earlyAccessConfig` (download vs generation price, trial
  limits, donation goals). Only the **generation price** is a candidate for retirement, since licensing fees now cover
  that.
- **MODELS-3 — Indefinite-sale.** It is **early-access pricing with no end date** (same mechanism). The main-app backend
  needs the no-end-date representation; scope/own with backend.
- **MODELS-4 — Publish / schedule.** **v1 — critical.** Managing your models (publish/schedule + bulk fee editing) is
  the whole point of v1.
- **MODELS-5 — Pagination.** **Cursor-based virtualized infinite scroll** (load-more) with strong filters/sort/search
  and a total count shown — **not** numbered pages. Numbered/offset paging can be added later only if page-jumps are
  explicitly requested.

**Also resolved (Justin):** table **grouped by model, versions nested** · **drafts shown** · **settlement currency is not
a creator choice** (Civitai-only, special cases) · optimistic updates OK.

**Still open / deferred:** indefinite-sale's main-app no-end-date backend representation must land before the studio
control is real (MODELS-3, coordinate with backend).
