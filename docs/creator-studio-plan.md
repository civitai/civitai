# Creator Studio (`creator.civitai.com`) — Implementation Plan

> **Status:** Draft for review. Synthesised from the [Creator Release 2026 HackMD](https://hackmd.io/@civitai/r1F6wi-7Me),
> the ClickUp task (868k6zt4m), and a code-map of the current main app. Decisions + open questions for Justin are in
> [§9](#9-decisions--open-questions).

## 1. What this app is

**Creator Studio is a new SvelteKit spoke app at `creator.civitai.com` — "the single home for managing everything a
creator earns from."** It is the UI surface for the **Creator Release 2026**, which replaces the flat **25% generation
compensation** with creator-controlled earning: **licensing fees**, **sellable model access (no time cap)**, and a
**Creator Shop**.

Scope (from the ClickUp task), all creator-facing:

1. **Bulk licensing-fee edits** across many models, with model-type default-fee suggestions.
2. **Shop management** — cosmetic submission, listing order, models toggle, publish. *(Deferred: built in the main app first — see below.)*
3. **Earnings + analytics** — license fees, tips, model-access sales, cosmetic sales; usage analytics.
4. **Model management** — early/paid-access toggles.

**v1 is Studio-only.** It does *not* absorb general creator surfaces (model upload, posts, profile settings) from the
main app; those stay put for now.

**Access model (confirmed by Justin):** **any logged-in user can access Creator Studio.** Specific items/actions are
restricted to **Creator Program members** — a **single gate** for all gated actions. The app is *not* CP-gated at the
door — the gate is "authenticated," and member-only capabilities (e.g. setting a licensing fee) are enforced per-action
on Creator Program membership.

**v1 build priority (from the designer meeting):** **model management** and **basic analytics** come first; the
**Creator Shop is out of v1** — see the shop note below.

**Licensing-fee rules (confirmed by the designer):** a licensing fee is **per model version**; **members** can turn it
on and adjust it; **non-members cannot set one**.

**Creator Shop is being built in the main app by another dev** (confirmed by Justin) and will be **transferred into
Creator Studio later**. It is therefore **out of scope for this app's v1** — all shop questions are deferred to that
work. This resolves the earlier designer-vs-HackMD tension: shop ships (in the main app), just not here yet.

### Cutover — a separate backend track (not this app's v1)

Retiring 25% compensation and activating licensing fees still land together on the **backend**, but per Justin this
cutover is **decoupled from Creator Studio v1: the app ships ~1 week before the cutover.** Fees set during that
pre-cutover week carry a **special "not-yet-payable" flag** so they don't pay out until the cutover flips. So
comp-retirement is its **own backend track**, not part of this app's v1 ([§8](#8-phasing)).

---

## 2. Architecture & tooling

Creator Studio is a **spoke app** in this monorepo, exactly like `apps/moderator` and `apps/auth`. Do **not** port the
main app's React/Mantine components — these apps are **Svelte 5 / SvelteKit / Tailwind v4**.

**Read these first (they are the source of truth for the wiring):**

- [`docs/packages/new-app-integration.md`](packages/new-app-integration.md) — the app-bootstrap + data-layer companion.
  Covers the cherry-pick model, the `process.env` shim, `ssr.noExternal` transpile requirement, and the env cheat-sheet.
- [`docs/auth/spoke-integration-guide.md`](auth/spoke-integration-guide.md) + [`docs/auth/auth-hub-spoke-overview.md`](auth/auth-hub-spoke-overview.md)
  — the hub↔spoke auth contract (`civ-token`, `@civitai/auth`, `createSpokeGuard`).
- [`packages/civitai-ui/README.md`](../packages/civitai-ui/README.md) — **`@civitai/ui`**, the shared shadcn-svelte
  component package (24 primitives + dark-only theme, Tailwind v4). Consume it; add new *shared* components into it, not
  into the app.

**Scaffolding:** use the **`scaffold-civitai-app`** skill to stand up `apps/creator-studio`. It cherry-picks only the
packages we import and wires each one's dependency, transpile entry, env vars, and server shim (SvelteKit by default).

**SvelteKit tooling notes** (consolidated so we don't re-learn them):

| Concern | Decision |
|---|---|
| Framework | SvelteKit + `@sveltejs/adapter-node`, Svelte 5, Vite |
| UI | `@civitai/ui` (shadcn-svelte / `bits-ui`) — reach for shadcn-svelte before hand-building; Civitai composites (EdgeMedia, ImageGuard, masonry) get built *on top of* the primitives, into `@civitai/ui` |
| Styling | Tailwind v4 (`@tailwindcss/vite`), dark-only (`<html class="dark">`), `@import '@civitai/ui/theme.css'`, `@source` the package so classes aren't purged |
| Auth | `createSpokeGuard` in `hooks.server.ts`; gate is **any authenticated user** (`require: (u) => !!u`). Member-only actions are enforced per-action on **Creator Program membership** (see [§5](#5-apiservice-plan)) |
| Data | `@civitai/db/kysely` (env-free, no Prisma engine) for domain reads/writes; monetization **mutations run in-process** via a creator-studio **module** (kysely + `@civitai/buzz`) — **no main-app tRPC hop**. See [§5](#5-apiservice-plan) |
| Buzz | `@civitai/buzz` — a **server-side-only** client for the buzz service (transactions + earnings reads). All buzz comms are server-side; never imported into browser code |
| Env | app-local `.env` (+ committed `.env.example`); `process.env` shim in `vite.config.ts` |

**Package discipline (avoid sprawl).** A thing becomes a shared `@civitai/*` **package** only when **(1) ≥2 apps
actually import it** *and* **(2) it's a coherent, nameable capability** — not "a slice of shared logic." Otherwise
it's a **module inside the app**, extracted to a package only when a second app needs it (rule-of-three). For v1 that
means exactly **one** new package — `@civitai/buzz` — with monetization writes and analytics reads living as
**creator-studio modules** until the full-cutover consolidation ([§9](#9-decisions--open-questions)).

---

## 3. Page list (v1)

Routes under `apps/creator-studio/src/routes/`. Grouped, minimal, one screen per job.

| Route | Page | Purpose |
|---|---|---|
| `/` | **Dashboard / overview** | At-a-glance earnings across all sources + headline stats; entry points to each section. |
| `/earnings` | **Earnings** | Breakdown by source: license fees, tips, model-access sales, cosmetic sales. Time-series + totals. Links to CP cash/withdrawal. |
| `/earnings/analytics` | **Basic analytics** ⭐ | Model usage that drives fees (generations per resource, downloads, engagement over time). **v1 priority — keep "basic" for v1; richer analytics is post-v1.** |
| `/licensing` | **Licensing fees (bulk editor)** | Table of the creator's models/versions; multi-select; set/clear fee; apply model-type default suggestions (LoRA ~0.1, base ~1 buzz/image); fractional pricing. *(Bulk editor may trail the per-version editor on `/models` — [§8](#8-phasing).)* |
| `/models` | **Model management** ⭐ | Grouped by model (versions nested, **drafts included**). Per-version: **full** early/paid-access config, licensing-fee on/off + amount (**CP members**), "sell access indefinitely" (**CP members**), and **publish/schedule**. **v1 priority.** See [models.md](creator-studio/models.md). |
| `/settings` | **Payout & settings** | Payment config (Tipalti) status, Creator Program membership status, per-account default fee suggestions. |
| `/join` | **Membership upsell** | Shown to non-members (any logged-in user can reach the Studio): what Creator Program membership unlocks + link to join. |

Public/allowlisted (pre-gate): `/favicon.svg`, health check.

> **Shop pages are not in this app's v1.** Shop management (`/shop`, `/shop/items/[id]`) is being built in the **main
> app** by another dev and transferred into Creator Studio later; routes reserved but not built here now.

**Navigation.** Desktop = **sidebar**, mobile = **header nav** — both come from `@civitai/ui`'s shadcn `sidebar` +
`sheet` + `is-mobile` hook (the responsive collapse is largely built in). Both navs render from a **single app-local
constant** (`apps/creator-studio/src/lib/nav.ts` — `{ href, label, icon, memberOnly? }[]`) that mirrors this table, so
the two can't drift and adding a page is a one-line change. It's app-local config (one app → a module, not a package).
Notes: match **active state** carefully for nested routes (`/earnings` vs `/earnings/analytics`); `memberOnly` lets
both navs conditionally show/disable member-gated items off the user's **Creator Program membership** (ties into the [§5.2](#52-reuse-existing-main-app-endpointsservices) gate).

---

## 4. Feature → workstream map

| # | Workstream | Built today? | v1 work |
|---|---|---|---|
| 1 | Retire 25% comp | Live (to sunset) | **Post-v1 cutover track** (not this app's v1): stop minting `Compensation` rows; remove comp UI; keep tips + license-fee payout paths |
| 2 | Creator-controlled licensing fees | **Mostly built** | Fractional pricing, Creator Program membership gating, **bulk edit** (new), default suggestions |
| 3 | Sell model access (no time cap) | Partially (score-capped EA) | Remove time/qty caps for members; expose toggle in Studio |
| 4 | Creator Shops | **Being built in the main app** (by another dev) | Not this app's v1 — transferred into Creator Studio later; cosmetics 70/30; Shopify merch is fast-follow |
| 5 | Creator Studio | **Net-new** | This whole app |

---

## 5. API / service plan

### 5.1 The core architectural decision — where does business logic run?

**Starting point: the money ledger is already a separate service.** `createBuzzTransaction` doesn't write a local table
— it POSTs to `BUZZ_ENDPOINT` (`buzzApiFetch('/transaction')`, `buzz.service.ts:383`). The buzz service is a standalone
**.NET / ASP.NET Core Minimal API on PostgreSQL** (`C:\work\civitai-buzz`) with ClickHouse only as a post-commit
tracking sink. So the ledger is *not* something to extract — it's already external, and every app is a *client* of it.

What lives in the main app is **monetization *orchestration***, not the ledger: validate → call the buzz service →
**co-write domain rows** in the same flow (early-access purchase mints the buzz transaction *and* an `EntityAccess`
grant + version meta), plus fee rules, stacking, split recipients, tier gating — all over `ModelVersion` /
`CustomerSubscription`.

**Decision (agreed with the team): server-side, in-process; Studio runs mutations itself — no main-app tRPC hop.
One new *package* (`@civitai/buzz`); monetization writes are a creator-studio *module*, not a package yet
(package discipline, [§2](#2-architecture--tooling)).**

```text
@civitai/buzz        (PACKAGE — built) server-side client for the buzz service. Earns package status: the main app
                     already uses it broadly AND creator-studio needs it. Lifted out of buzz.service.ts.
                     SERVER-ONLY — no browser entry; all buzz comms stay server-side.
monetization module  (creator-studio MODULE — apps/creator-studio/src/lib/server/monetization/, NOT a package yet)
                     the creator ops: setLicensingFee, bulkSetLicensingFee, setUnlimitedAccess + CP-membership gate.
                     Deps: @civitai/db (kysely) + @civitai/buzz. NO ClickHouse. NO stacking (backend handles it).
```

Why a module, not a package: in v1 **only creator-studio** writes fees (the main app keeps its own inline version),
so the ops have a **single caller** — no cross-app sharing yet, so no package. They graduate to a package **only at
the consolidation** (full cutover), when the main app adopts the same code ([§9](#9-decisions--open-questions)).

Imported **only in server code** — in creator-studio that's `+page.server.ts`, form actions, `+server.ts`,
`hooks.server.ts`. The browser calls creator-studio's own server, which runs the operation in-process:

```text
BROWSER ─► creator-studio SERVER ─► monetization module ─► @civitai/buzz ─► buzz service (.NET)
 (no buzz)   (SvelteKit load/actions)   (kysely domain writes)   (package)
```

**Why in-process (module/package), not a service or a tRPC hop:**

- A **standalone monetization service** is the wrong shape: the orchestration co-writes main-app domain tables, so a
  service would need those tables (moving the *domain*, not payments) or add distributed-transaction failure modes on
  *money* code. Running in-process keeps the buzz-call ↔ domain-write co-transactionality inside each consumer.
- **`@civitai/buzz` earns package status** (main app uses it broadly + creator-studio); the monetization ops do **not
  yet** (one caller in v1) — extract them to a package when the main app adopts them, not before.

**Cost note:** the eventual package extraction (at consolidation) means porting the moved functions Prisma→kysely and
repointing the main app's live call sites — money-critical. But **v1's creator-side writes are new, small, and
single-app**, so there's **no extraction on the critical path** (Q1 decided minimal — [§9](#9-decisions--open-questions)).

**Earnings/analytics reads — ClickHouse, not the buzz service (Justin):**

All earnings + analytics read from **ClickHouse**, *not* the buzz service — querying the buzz service for dashboards
is **too slow**. Buzz earnings already land in ClickHouse, and aggregate tables like `resourceCompensations` are
already **daily aggregates** — the right source. Design for scale from **materialized views / daily records**, never
individual rows, and audit which mat views exist vs. need adding ([§7.6](#76-clickhouse-analytics--materialized-views)).
Creator Studio reads via `@civitai/clickhouse` (a **required** v1 dep). *(The buzz client's report endpoints exist but
are **not** the analytics path.)*

### 5.2 Reuse (existing main-app endpoints/services)

| Need | Existing surface |
|---|---|
| Is the user a Creator Program member? | **Creator Program membership** is the single gate (resolved 2026-07-02): `creatorProgram.getCreatorRequirements` (`creator-program.service.ts:205`) — CP membership = subscription tier **+** creator score ≥40k. Used for every gated action (fee-set, indefinite-sale, default-fee pref). |
| Earnings + analytics (all) | **ClickHouse** via `@civitai/clickhouse` — buzz earnings + `resourceCompensations` aggregates live here; the buzz service is too slow for this. Work from materialized views / daily records ([§7.6](#76-clickhouse-analytics--materialized-views)) |
| CP cash / banked / pool | `creatorProgram.getCash` / `getBanked` / `getCompensationPool` (`creator-program.router.ts`) |
| Set a licensing fee (single) | `modelVersion` upsert — `licensingFee*` fields (`model-version.schema.ts:418`), flag `licensing-fee` |
| Early/paid access config + purchase | `modelVersion.earlyAccessPurchase`, `earlyAccessModelVersionsOnTimeframe` (`model-version.router.ts`) |
| Cosmetic purchase + 70/30 split | `cosmeticShop.purchaseShopItem`; split via `meta.paidToUserIds` → `TransactionType.Sell` (`cosmetic-shop.service.ts:619`) |

### 5.3 New monetization operations (creator-studio module; extract to a package at consolidation)

These are **module functions** in creator-studio, not main-app tRPC procedures — creator-studio calls them from its
own server. The main app keeps its **own inline fee/access logic** for v1; the two converge onto one shared
implementation only at the consolidation ([§9](#9-decisions--open-questions) "full cutover").

| Operation | Why |
|---|---|
| `setLicensingFee` / `bulkSetLicensingFee` | Per-version fee set (member-only) + bulk edit across many versions — no bulk path exists today. |
| `getDefaultFeeSuggestions` | Model-type default suggestions (LoRA ~0.1, base ~1 buzz/image). |
| `setUnlimitedAccess` | Remove EA time/quantity caps for members. |
| fee validation (member gate + fractional) | Enforce **Creator Program membership** + fractional bounds when setting a fee. **Stacking/split is NOT here** — the backend already handles it ([§7.3](#73-fee-stacking--already-handled-no-new-work)). |
| Creator Program membership gate | Authorization asserted **inside the module** on member-only operations (and reused when the main app adopts it at consolidation). |

Earnings reads are **not** package operations — all analytics come from **ClickHouse** via `@civitai/clickhouse`
([§5.2](#52-reuse-existing-main-app-endpointsservices), [§7.6](#76-clickhouse-analytics--materialized-views)).
Per-creator shop CRUD is out of scope (main-app shop work owns it, see [§1](#1-what-this-app-is)).

---

## 6. Main-app code to REMOVE

**Strategy (per decision): redirect-first.** In v1 we do **not** delete the superseded main-app code. We (a) redirect
the relevant routes to `creator.civitai.com`, and (b) mark each block for deletion with
`// TODO(creator-studio): remove after Creator Release cutover` so a later phase can safely rip it out. The 25%-comp
*payout* change is the one behavioural change that lands at cutover.

### 6.1 Retire 25% generation compensation (behavioural — at cutover)

| File | What |
|---|---|
| `src/server/jobs/deliver-creator-compensation.ts:150` | **Stop minting `Compensation`-type `BuzzTransaction` rows at cutover**; keep `tip` + `licenseFee` payout paths. This is the real sunset. |
| `src/store/tip.store.ts:4` | `creatorTip: 0.25` default → remove creator-tip default. |
| `src/components/generation_v2/FormFooter.tsx:150` | Remove `creatorComp && hasCreatorTip` tip line from cost calc. |
| `src/components/ImageGeneration/GenerationForm/GenerationCostPopover.tsx:108` | Remove creator-tip rate UI. |
| `src/components/Buzz/Rewards/DailyCreatorCompReward.tsx` | Remove the "Compensation" tab; License-Fees view moves to Studio `/earnings`. |
| `src/pages/user/buzz-dashboard.tsx:77` | Remove `creatorComp`-gated comp section; **redirect** creator-earnings entry to `creator.civitai.com/earnings`. |
| `src/server/services/feature-flags.service.ts` | Retire the `creatorComp` flag once UI is gone. |

### 6.2 Redirect superseded management surfaces

| Main-app surface | Redirect target |
|---|---|
| Buzz dashboard creator-earnings section (`buzz-dashboard.tsx`) | `creator.civitai.com/earnings` |
| Licensing-fee editing in `ModelVersionUpsertForm.tsx:800` | **Keep (per Justin)** — inline fee editing stays as an additional surface until model management is fully deprecated from the main site. Not redirected/removed in v1; optionally add a "manage all fees" link → `creator.civitai.com/licensing`. |
| Any "creator score → early access caps" management copy (`constants.ts:1708`) | Superseded by member "sell indefinitely"; keep score caps for non-members, add Studio link. |

> Every redirect/removal block gets the `TODO(creator-studio)` marker so the post-release cleanup is a grep away.

---

## 7. New packages, schema & cross-team work

What has to be built/changed outside Creator Studio's own UI for it to work.

### 7.1 Schema / data (main-app DB)

| Change | Detail |
|---|---|
| **Fractional licensing fee** | `ModelVersion.licensingFee` is `Int` today (`schema.full.prisma:1042`, `MAX_LICENSING_FEE=100`). Justin confirmed fees as **small as 1 buzz per 100 images = 0.01 buzz/image**, so we need **decimal** with **0.01 precision**. Migrate to `numeric`/decimal; settle sub-buzz amounts at the **daily payout boundary** (not floored per transaction) in `deliver-creator-compensation.ts`. Manual migration (repo does not run `prisma migrate deploy`). |
| **Access "unlimited" flag** | Represent "available for sale indefinitely, no time/quantity cap" on the model version (extend `earlyAccessConfig` or add a field) so **Creator Program members** (per Justin) bypass `scoreTimeFrameUnlock`/`scoreQuantityUnlock`. Needs main-app support + studio integration ([models.md](creator-studio/models.md)). |
| **Licensing-fee "active" flag** (per Justin) | A member's fee must **auto-pause** when they have no active membership — the set **value is never removed**, only whether it *applies*. The **mini endpoint** (`src/pages/api/v1/model-versions/mini/[id].ts`, where Koen resolves the fee) checks active membership on hit to decide whether the fee applies, and the flag drives whether the fee shows on the model card. Add an `active`/`enabled` flag on the version's licensing fee. The pre-cutover "not-yet-payable" flag ([§1](#1-what-this-app-is)) is the same kind of gate for the launch window. |

Per-creator shop schema (owner + submission/approval on `CosmeticShopSection`/`CosmeticShopItem`) is **owned by the
main-app shop work**, not this plan.

### 7.2 New package + creator-studio modules

- **`@civitai/buzz`** (**package, built**) — server-side client for the buzz service, lifted out of `buzz.service.ts`;
  both apps import it. Server-only, no browser entry. *(The one thing that earns package status now — [§2](#2-architecture--tooling).)*
- **Monetization module** (creator-studio, **not a package yet**) — the [§5.3](#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)
  ops, built on `@civitai/db` (kysely) + `@civitai/buzz`, authorization inside, **no ClickHouse**. Lives in
  `apps/creator-studio/src/lib/server/monetization/`.
- **Analytics reads module** (creator-studio, **not a package**) — ClickHouse reads via `@civitai/clickhouse`
  ([§7.6](#76-clickhouse-analytics--materialized-views)).
- **Consolidation (post-v1, not v1)** — at the full cutover, extract the monetization module into a shared package and
  repoint the main app's inline fee/access logic (`model-version.service.ts`) onto it so it exists **once**.
  Money-critical (Prisma→kysely port + dep untangling); deferred off v1's path ([§9](#9-decisions--open-questions)).

### 7.3 Fee stacking — already handled (no new work)

Per Justin, **stacking is already handled on the backend** — a derivative fee stacking on the base model's fee is a
backend concern, not something creators do. There is **nothing for creators to do here beyond setting their own
licensing fee.** So the earlier "must implement additive stacking + split payout" is **not** Creator Studio work, and
it does **not** land in the monetization module. *(Eng note: the lineage/base fee now comes from a derivative's
explicit parent root (`licensingSourceVersionId` → its `LicensingRoot`), stacked on top of the creator's own
per-version fee — the two are independent, so a creator can always set their own fee. The old
`BaseModelLicensingFee` fallback that this note used to worry about no longer exists.)*

### 7.4 Cross-team dependencies & coordination

The design has cross-team dependencies — surface these early (likely with **Koen / backend**):

- **ClickHouse / data** — the earnings **`source`** split (compensation / licenseFee / tip) already exists in
  `orchestration.resourceCompensations`; the real add is the **owner-keyed earnings rollup**
  ([§7.6](#76-clickhouse-analytics--materialized-views)). *(The earlier concern about tagging the buzz-service report
  endpoints is moot — analytics read from ClickHouse, not the buzz service.)*
- **Main-app owner** — sign-off on the [§7.2](#72-new-package--creator-studio-modules) **consolidation** refactor:
  repointing live, money-critical fee/access call sites onto the extracted monetization package at the cutover.
- **Buzz-service owner** (`C:\work\civitai-buzz`, .NET) — only if v1 shows **access/cosmetic-sale** earnings by source
  (those are buzz transactions — [§7.6](#76-clickhouse-analytics--materialized-views) gap #2).

### 7.5 Engineering to-dos (not Justin — eng verification)

- Earnings **by source** is already available: `orchestration.resourceCompensations.source` = comp / licenseFee / tip
  (confirmed by the live audit). The remaining gap is the **owner-keyed rollup** ([§7.6](#76-clickhouse-analytics--materialized-views)).
- The `earlyAccessPurchase()` **dependency-map** is now **optional** — with Q1 minimal and the extraction deferred to
  the post-v1 consolidation, it's off any critical path. Do it when scoping the consolidation.

### 7.6 ClickHouse analytics — materialized views

Analytics + earnings read from **ClickHouse** via `@civitai/clickhouse` (**required** v1 dep), from **daily
aggregates**, never individual rows (the buzz service is too slow). Inventory from a live audit (2026-07-01):

**Exists — reuse (all keyed by `modelVersionId, date`):**

| Need | Table |
|---|---|
| Earnings by resource + **source** (comp / licenseFee / tip) | `orchestration.resourceCompensations` (SummingMergeTree; +`accountType`, `source`) |
| Earnings mirror (comp/tip split) | `default.buzz_resource_compensation` |
| Generations per resource | `default.daily_resource_generation_counts` |
| Downloads | `default.daily_downloads`, `daily_downloads_unique`, `modelVersionUniqueDownloads` |
| Model/version metrics | `default.entityMetric*` suite |

**Needs adding — the gap is the creator/owner dimension.** Every earnings aggregate is keyed by `modelVersionId`,
never the owner's `userId` (the `userId` columns that exist — `daily_user_resource`, `userModelDownloads` — are the
*generator/downloader*, not the creator). So "creator X's earnings" needs `modelVersion → ownerUserId`:

1. **Owner-keyed earnings rollup** — an MV aggregating `(ownerUserId, date, source) → sum(amount)` off
   `resourceCompensations` (+ a `modelVersion → ownerUserId` dictionary in CH). Scales better than app-side
   `WHERE modelVersionId IN (…)`, which balloons for prolific creators.
2. **Per-creator access/cosmetic-sale earnings** (only if v1 needs them) — those are buzz *transactions*, not in
   `resourceCompensations`; `buzz.transactions_daily_stats` is platform-wide (no account dimension). Would need a
   per-`toAccountId` daily buzz-earnings-by-type MV.

**Shared read logic:** the CH *client* (`@civitai/clickhouse`) is already shared by both apps. The creator-earnings
*query* logic is new in Creator Studio and legacy in the main app (`getDailyCompensationRewardByUser`, being
redirected). Consolidating both onto **one** server-side read module is a **full-cutover** item ([§9](#9-decisions--open-questions))
— worth it so both domains show identical numbers during the transition.

---

## 8. Phasing

Ordering reflects the **designer steer**: model management + analytics lead. The shop is **not this app's job**
(main-app dev owns it; transfers in later). The **comp⇆fee cutover is a separate backend track** — Creator Studio v1
ships **~1 week before** it (Justin), so comp-retirement is **not** a v1 item.

### v1 — MVP (designer-prioritised)

1. **App shell** — scaffold `apps/creator-studio`, auth spoke gate (**any authenticated user**) + Creator Program
   membership action gating, `@civitai/ui`, dashboard.
2. **Buzz package + monetization module** — `@civitai/buzz` (client, **built**) + a creator-studio **monetization
   module** (creator ops: `setLicensingFee` / `bulkSetLicensingFee` / `setUnlimitedAccess` + Creator Program membership gate; **no
   stacking** — backend handles it) built on `@civitai/db` + `@civitai/buzz` ([§7.2](#72-new-package--creator-studio-modules)).
   No main-app repoint in v1 — that's the consolidation (post-v1).
3. **Model management** ⭐ — `/models`: per-version early/paid-access toggles, per-version **licensing-fee on/off +
   amount (members only; non-members cannot set)**, "sell access indefinitely" for CP members.
4. **Analytics** ⭐ — `/earnings/analytics` + `/earnings`: read from **ClickHouse** (daily aggregates / materialized
   views, [§7.6](#76-clickhouse-analytics--materialized-views)) — **not** the buzz service.
5. **Licensing-fee mechanics** — fractional pricing (schema migration + daily-boundary settlement) + the
   **membership-gated "active" flag** and pre-cutover "not-yet-payable" flag ([§7.1](#71-schema--data-main-app-db)).
   **No stacking work** (backend). Bulk editing / default suggestions can trail the per-version editor.

**Not in v1 (separate backend track):** retiring 25% comp + activating fees flips **~1 week after** v1 ships
([§1](#1-what-this-app-is)).

### Post-v1 — fast-follow / later

- **Comp⇆fee cutover** (~1 week after v1) — flip fees live + stop minting `Compensation` rows
  ([§6.1](#61-retire-25-generation-compensation-behavioural--at-cutover)); pre-cutover fees become payable.
- **Transfer the Creator Shop into Creator Studio** — the main-app dev's shop (cosmetics, 70/30) moves here; **Shopify
  merchandise** trails that (blocked on Shopify token).
- **Bulk licensing-fee editor + model-type default suggestions** — if not landed in v1.
- **Delete** the redirect-marked main-app code (the `TODO(creator-studio)` sweep).
- **Broaden the Studio** beyond monetization (model upload, posts, profile settings migration) — *only if the "creator
  hub" direction is later chosen.*
- Richer analytics (cohorts, per-model funnels), cash-flow forecasting.

---

## 9. Decisions & open questions

### Decided (Justin, 2026-07-01)

- **Access model.** Any logged-in user can access Creator Studio; member-only items/actions are gated on **Creator
  Program membership** — a **single bar** for all gated actions (fee-set, indefinite-sale, default-fee pref), resolved
  2026-07-02. → app gate is "authenticated," not CP-only at the door ([§1](#1-what-this-app-is), [§2](#2-architecture--tooling)).
- **Timeline.** Launch by **end of month (~2026-07-31)**; Justin is working the orchestrator side with **Koen**.
- **Fractional pricing.** Fees as small as **1 buzz per 100 images = 0.01 buzz/image**. → migrate `licensingFee` to
  decimal (0.01 precision), settle at the daily payout boundary ([§7.1](#71-schema--data-main-app-db)).
- **Shop.** Being built **in the main app** by another dev; transferred into Creator Studio **later**. → out of this
  app's v1; all shop questions deferred to that work.
- **Infra.** `creator.civitai.com` as an auth spoke — **confirmed**.
- **Service topology (eng decision).** Buzz ledger is already an external service. No standalone monetization service.
  Server-side, in-process: **one new package** — `@civitai/buzz` (buzz-service client, built) — plus **creator-studio
  modules** for monetization writes (kysely + buzz; auth inside) and analytics reads (ClickHouse); Studio runs
  mutations itself with **no main-app tRPC hop**. Modules graduate to packages only at the consolidation, per the
  package bar ([§2](#2-architecture--tooling)). Analytics read from **ClickHouse** (Q6 below), not the buzz service
  ([§5.1](#51-the-core-architectural-decision--where-does-business-logic-run)). *What remains for Justin is Q1's
  timeline/scope tradeoff, not the topology.*
- **Fee stacking (Q2).** Already handled on the backend — creators only *set* their fee; no stacking/split work in
  Creator Studio ([§7.3](#73-fee-stacking--already-handled-no-new-work)).
- **Membership gating (Q3).** Fees **auto-pause** when a member lapses; the set value is kept, only its application is
  gated. The **mini endpoint** checks active membership on hit; add an `active` flag on the version's fee for card
  display ([§7.1](#71-schema--data-main-app-db)).
- **Inline fee editing (Q4).** Stays on the main app as an additional surface until model management is fully
  deprecated there ([§6.2](#62-redirect-superseded-management-surfaces)).
- **Cutover timing (Q5).** The comp⇆fee cutover is a **separate backend track**; Creator Studio v1 ships **~1 week
  before** it. Pre-cutover fees carry a "not-yet-payable" flag ([§1](#1-what-this-app-is), [§8](#8-phasing)).
- **Analytics source (Q6).** All analytics/earnings read from **ClickHouse** (daily aggregates / materialized views),
  not the buzz service (too slow). ClickHouse is a required v1 dep ([§7.6](#76-clickhouse-analytics--materialized-views)).

### Decided — Q1: minimal monetization scope for v1

The creator-studio **monetization module** ships the **minimal creator-side writes only** — `setLicensingFee` /
`bulkSetLicensingFee` with a Creator Program membership gate and the `active` flag ([§7.1](#71-schema--data-main-app-db)), plus
`setUnlimitedAccess` (same shape). These are plain `ModelVersion` writes — no buzz call, no domain co-write. The risky
buyer-side paths (`earlyAccessPurchase`, cosmetic purchase) **stay in the main app**; they don't move for v1. It's a
**module, not a package** (single caller in v1 — [§2](#2-architecture--tooling)); with the cutover decoupled (Q5) the
extraction is off the critical path, so the dependency-map (§7.5) is no longer a blocker.

### Resolved — review pass (2026-07-02)

Product/business calls resolved from the Q&A roundup. (Eng/design-owned items — charting lib, `/licensing`
separate-vs-mode, owner-keyed rollup, etc. — are resolved in [creator-studio/README.md](creator-studio/README.md#cross-cutting-decisions-resolved-2026-07-02).)

- **PLAN-TC / PLAN-1 — Member gate.** **Creator Program membership is the single bar** for every gated action (fee-set,
  indefinite-sale, default-fee pref). No feature-specific split and no subscription-tier-only gate. Higher-tier-only
  features may come eventually, but v1 gates everything on CP membership.
- **PLAN-2 — Indefinite-sale mechanics.** It is an **extension of early-access pricing using the same mechanism** — one
  simply has **no early-access end date**. (Early access becomes the switch you flip when selling a model.) Needs the
  main-app no-end-date representation ([§7.1](#71-schema--data-main-app-db)).
- **PLAN-3 — v1 earnings sources.** **All sources day 1** ideally, with a **source filter** (model access, cosmetic,
  comp, licenses, tips; merch later). **Comp + licenses can share a chart** (comp is being retired). Access-sale +
  cosmetic-sale need the [§7.6 gap #2](#76-clickhouse-analytics--materialized-views) MV.
- **PLAN-4 / PLAN-11 — Analytics scope + defaults.** v1 charts: generations-over-time (weekly option + split by buzz
  color blue/yellow/green), earnings-over-time by source (weekly, week-over-week delta), a top-models table (per-week
  earnings + generations + fee set), stat tiles, and a pricing-reference metric (avg buzz cost/image by base model +
  type). Confirm the final list with Alex DS before locking.
- **PLAN-5 — Fee auto-pause → notify.** **Yes** — notify via **in-app + email**; the email **lists the affected models**
  no longer collecting fees. **Notifications are needed in v1** (fee paused, payout ready), eased by the new
  notifications app/SDK.
- **PLAN-6 — Cutover comms / grandfathering.** Comms story lives in the dedicated article
  ([civitai.com/articles/32087](https://civitai.com/articles/32087)). Creators get a **1-week window** to set licensing
  fees, then Creator Comp is gone — **no grandfathering**. (Recommendation on the table: settle comp already accrued up
  to the cutover, then stop all new accrual — kinder than a clean zero.)
- **PLAN-7 — Max licensing fee.** Floor **0.01 buzz/image**, cap stays **100 buzz/image** (`MAX_LICENSING_FEE`).
- **PLAN-8 — Discoverability.** A **nav item in the main-site user menu** linking to the Studio + a **launch
  announcement** + a **nice notice on the Buzz dashboard** (where banking/creator controls live) pointing to the Studio.
- **PLAN-9 — Publish/schedule + bulk fee editor.** **v1 — critical.** Managing your models is the whole point of v1.
- **PLAN-10 — Currency display.** Display earnings **in the currency received** (buzz or USD); **no conversion/mapping**
  (no rate exists). USD is available only for select users; most creators are buzz-only and don't set a currency.
- **PLAN-11 — Default fee suggestions + eligible types.** Values LoRA ~0.1, base ~1 buzz/image. Model types are handled
  as an **exclude set** — every type gets a fee **except**: **Poses, Wildcards, Workflows, Other, Detection,
  VisionLanguage, LLM, CLIP, CLIPVision, TextEncoder**. **UNet IS eligible** (increasingly used like a checkpoint).

### For the full cutover (post-v1 notes)

- **Extract the monetization module into a package** and repoint the main app's own fee-set call sites onto it so
  there's one implementation (today `ModelVersionUpsertForm` → main-app service writes the fee; that stays until this
  consolidation). This is when the module graduates to a package (second app now imports it — [§2](#2-architecture--tooling)).
- **Consolidate earnings/analytics reads** — the main app's legacy `getDailyCompensationRewardByUser`
  (`buzz.service.ts:1142`) and Creator Studio's new ClickHouse reads should resolve to **one** server-side read module
  so civitai.com and creator.civitai.com show **identical** numbers during the transition ([§7.6](#76-clickhouse-analytics--materialized-views)).
- **Add the owner-keyed earnings rollup** in ClickHouse ([§7.6](#76-clickhouse-analytics--materialized-views)).
- **Flip comp-retirement + fee activation** together (the cutover, ~1 week after v1); make pre-cutover fees payable.
- **Delete** the redirect-marked main-app code (the `TODO(creator-studio)` sweep).

---

## Appendix — key code references

- **Comp payout:** `src/server/jobs/deliver-creator-compensation.ts` (daily 02:00 UTC; `tip|compensation|licenseFee` sources)
- **Licensing fee:** `ModelVersion.licensingFee*`, `ModelVersion.licensingSourceVersionId` (a derivative's explicit parent root), `LicensingRoot` table (root membership + `isDefault`; replaces the old `LicensingRoot` flag + `BaseModelLicensingFee` pointer), `ModelVersionFlag.NotDerivative` (non-derivative versions skip parent attribution), `MAX_LICENSING_FEE=100` (`model-version.schema.ts`), flag `licensing-fee`. Fee resolution: root → own fee; explicit parent → its fee; no `(baseModel, modelType)` fallback.
- **Early access:** `earlyAccessConfig`/`earlyAccessEndsAt` (`schema.full.prisma:1035`), score caps (`constants.ts:1708-1738`), `earlyAccessPurchase()` (`model-version.service.ts:1481`)
- **CP membership:** `getCreatorRequirements()` (`creator-program.service.ts:205`), `MIN_CREATOR_SCORE=40000`, `OnboardingSteps.CreatorProgram=16`
- **Cosmetic shop:** platform-owned `/shop`; `purchaseCosmeticShopItem()` split (`cosmetic-shop.service.ts:619`); CRUD is moderator-only (`cosmetic-shop.router.ts`)
- **Spoke wiring:** `docs/packages/new-app-integration.md`, `docs/auth/spoke-integration-guide.md`, `packages/civitai-ui/README.md`, skill `scaffold-civitai-app`
