# `/models` — Model management ⭐

> **v1 priority.** The creator's control surface for monetizing their own model versions: early/paid-access toggles,
> per-version licensing fee (members only), and "sell access indefinitely." Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1),
> ops in [plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation).

## User story

As a creator, I open `/models` and see **my** models as rows with their **versions nested underneath** (drafts
included). Per version I manage **all monetization**: set/clear a **licensing fee** (members only), edit **early/paid
access** config, and — as a **Creator Program member** — make a version **available for sale indefinitely** (beyond
early access). Secondarily I can **publish or schedule a version's publish date** from here (a management convenience,
lower priority than fees). Changes save inline; I see immediately whether a fee is *active* or paused.

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
- The user's **member `tier`** and **CP-membership** status — the fee gate keys on `tier`; **indefinite-sale keys on
  Creator Program membership** (per Justin) — `CustomerSubscription → Product.metadata.tier` +
  `creatorProgram.getCreatorRequirements` ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
  *(The exact fee gate — tier vs full CP — is still a [pending confirm](../creator-studio-plan.md#9-decisions--open-questions).)*
- **Not** an analytics page — no ClickHouse here. Per-model earnings/usage live on [analytics.md](analytics.md).

## Actions (writes) — form actions → monetization module

All mutations go through the creator-studio **monetization module** (`src/lib/server/monetization/`), which writes
`ModelVersion` via kysely — **no buzz call, no ClickHouse** ([plan §5.1](../creator-studio-plan.md#51-the-core-architectural-decision--where-does-business-logic-run)):

| Action | Op | Notes |
|---|---|---|
| Set / adjust / clear licensing fee | `setLicensingFee(versionId, fee)` | **member-only**; fractional (0.01 precision); validate bounds. Value kept even when paused. |
| Edit early/paid access config | (access config write) | **Full** `earlyAccessConfig` (not just a toggle) — Justin wants *all monetization in the studio*. Field-by-field scope in Open questions. |
| Sell access indefinitely | `setUnlimitedAccess(versionId)` | **Creator Program members only** (per Justin) — indefinite availability beyond early access; needs main-app support ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)). |
| Publish / schedule publish | (publish write) | **Management convenience — 2nd priority to fees.** Publish a version or set its publish date from the studio. |

- **Authorization asserted inside the module** (disabled control is UX; the server re-checks): fee writes gate on member
  `tier`; **indefinite-sale gates on CP membership**.
- **Ownership check**: every action confirms `locals.user.id` owns the version.
- **Settlement currency is not a creator choice** — cash settlement is done by Civitai only, in special circumstances,
  on the creator's behalf (Justin). No per-version or per-account control.
- **Stacking is not handled here** — the backend does it ([plan §7.3](../creator-studio-plan.md#73-fee-stacking--already-handled-no-new-work)).

## States

- **Loading** — skeleton rows (`skeleton`).
- **Empty** — creator has no models → friendly empty state + link to upload on the main app.
- **Non-member / non-CP** — page loads; **fee** controls disabled (member gate) and **sell-indefinitely** disabled (CP
  gate) with an upsell to `/join`; access-config editing stays available (early access isn't member-gated). Drafts are
  listed with a draft badge.
- **Fee paused** — member set a fee then membership lapsed → fee shows `Paused`, value retained, not charged
  ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)). Pre-cutover fees show a "not-yet-payable" state.
- **Error** — inline row error + toast; optimistic update rolls back on failure.

## Gating

Gating is **feature-specific**: **setting a fee** keys on member `tier`; **sell-indefinitely** keys on **Creator
Program membership** (per Justin). Everything else (access config, publish) is open to any authenticated owner. Enforced
in UI (disabled + tooltip) and re-checked in the module. The exact *fee* bar (tier vs full CP) is still
[pending](../creator-studio-plan.md#9-decisions--open-questions) — Justin's CP answer for indefinite-sale hints the two
gates may genuinely differ.

## Shared / cross-refs

- Fee-setting also exists **inline on the main app** (`ModelVersionUpsertForm`) until model management is deprecated
  there ([plan §6.2](../creator-studio-plan.md#62-redirect-superseded-management-surfaces)) — same module at consolidation.
- Bulk fee editing across many versions is [licensing.md](licensing.md).
- Nav item is member-aware (`memberOnly`) via the shared `nav.ts`.

## Routing & URL state

- **Table state in the URL** — search (`?q=`), filters (`?status=`, `?fee=active|paused|off`, `?access=`), sort, page —
  read in `+page.server.ts` `load`, updated via `goto('?…', { keepFocus, noScroll })`; deep-linkable, refetches fresh.
- **Grouped rows** — which models are expanded is view state; keep ephemeral (or `?open=<modelId>` for linkable expansion).
- **Edit surfaces** — richer per-version editors (full access config, publish scheduling) open as a **URL-addressable
  drawer** (`?version=<id>`) via **shallow routing** (`pushState`) — linkable, back-button closes it, no page reload.
  Inline fee/on-off stays in the row.
- **Optimistic** money updates with rollback on failure (confirmed OK — the fee is a stored value, not a live charge).
- **Pagination** — offset vs cursor **undecided** (Justin: "not sure yet"); revisit for creators with many versions.

## Open questions

- **Fee gate — tier vs full CP membership** (still pending — [plan §9](../creator-studio-plan.md#9-decisions--open-questions)).
  Justin scoped **indefinite-sale to CP members**, so the gates may genuinely differ (fee = `tier`, indefinite = CP).
- **Access-config depth** — "all monetization in the studio" ⇒ expose the **full** `earlyAccessConfig` (download vs
  generation price, trial limits, donation goals) here; confirm the field-by-field v1 scope vs. what trails.
- **Indefinite-sale needs main-app work** — "available for sale indefinitely" (beyond early access, CP-gated) needs a
  main-app representation + backend ([plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db)) before the
  studio control is real. Scope/own with backend.
- **Publish / schedule from the studio** — confirmed wanted but **2nd priority to fees**; v1 or fast-follow?
- **Pagination** — offset vs cursor (undecided).

**Resolved (Justin):** table **grouped by model, versions nested** · **drafts shown** · **settlement currency is not a
creator choice** (Civitai-only, special cases) · optimistic updates OK.
