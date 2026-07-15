# Creator Studio — implementation checklist

**Single source of truth for status.** Everything open — build items, decisions, blockers, bugs, deferred work —
is tracked here. Detail and rationale live in the reference docs (linked inline); this file is the index of *what's
left*, not the *why*.

Reference: page specs (`dashboard.md`, `models.md`, `analytics.md`, `earnings.md`, `licensing.md`, `settings.md`,
`join.md`) · [pre-implementation-decisions.md](pre-implementation-decisions.md) (A/B/C decision log) ·
[owner-rollup-handoff.md](owner-rollup-handoff.md) + [cdc-koen.md](cdc-koen.md) (A1) ·
[questions-*.md](questions-justin-product.md) (answered Q&A) · [feedback-justin-round-2.md](feedback-justin-round-2.md)
(review notes).

Legend: `[x]` done · `[ ]` not started · `[~]` partial · **🚧** blocked on a dep · **🟢** needs a decision ·
**⏭** deferred / lower-priority · **🐛** flagged bug (upstream, not ours to fix).

---

## Shipped

### Shared / shell
- [x] App scaffold (SvelteKit spoke), auth gate, nav, layout, favicon
- [x] Membership resolver (Creator Program gate, **B1**) + moderator test simulator (`cs-test-membership` cookie)
- [x] Monetization module — `setLicensingFee` / `bulkSetLicensingFee` / apply-default-by-type (kysely); early-access write client → main-app REST endpoint `POST /api/v1/model-versions/early-access`
- [x] Axiom logging (`handleError` hook)
- [x] Redis read-through cache — `@civitai/redis` `createRedisCacheBuilder` / `createSysRedisCacheBuilder` → spoke `cache.ts`; range-scaled TTL
- [x] Charting primitive (**C1**) — Chart.js `Chart` wrapper in `@civitai/ui` (SSR-safe; `chartColor()` theme bridge)
- [x] `@civitai/buzz` wired (shim + `BUZZ_ENDPOINT`) — authoritative buzz-account reads (cash), not ClickHouse
- [x] Content/creator analytics reads module (`analytics.ts`, userId-keyed) + earnings/cash reads (`earnings.ts`, `cash.ts`)
- [x] Empty / unavailable / non-CP state hardening across dashboard, `/earnings`, `/analytics`

### `/models` — Model management ⭐
- [x] Grouped table (models → versions, drafts included); search / fee filter / sort / pagination (URL-driven)
- [x] Set / adjust / clear licensing fee — single + inline, fractional (0.01), CP-gated; status Off/Active/Paused
- [x] Bulk fee editing (`?mode=bulk`) — per-version + select-all, confirm dialog; apply-default-by-type
- [x] Non-commercial base-model guard; ownership + CP gate re-checked server-side
- [x] Full early/paid-access config editor (**B12**, full parity) — per-version drawer → main-app endpoint
- [x] States: empty, filtered-empty, non-member notice, error toasts

### `/` — Dashboard
- [x] Shell: headline stat cards + section link cards + member badge
- [x] Content-activity row (30d reactions/followers/images/posts/profile views, `getContentTotals`)
- [x] Buzz earned (30d) + CP cash cards (ready / pending / withdrawn, authoritative via `@civitai/buzz`); cash cards gated to CP members

### `/earnings` — Earnings by source (A1 Part 1)
- [x] By-source breakdown (comp / license / tip / access / cosmetic) — reads `buzzTransactions` directly (already owner-keyed); `licenseFee`+`'27'` filter, early-access prefix, cosmetic `sell`
- [x] Per-currency faithful display (**B8/D1**, no conversion/merge) — currency cards + source×currency table
- [x] Buzz-only per-currency trend chart (real buzz colors); Redis-cached; 7/30/90d + day/week controls
- [x] CP cash panel — **authoritative** ready / pending / withdrawn (buzz service + `CashWithdrawal`), USD (cents÷100), matches the Buzz dashboard; Buzz Dashboard link-out (**C6**: one cash home)

### `/analytics` — Basic analytics
- [x] Content/creator section (**B4b**): reactions/followers/images/posts/profile views over time + top-images; Redis-cached
- [x] Date-range control — 7/30/90d presets + day/week granularity (URL-driven)
- [x] Zero-activity + unavailable empty states
- *(route moved `/earnings/analytics` → `/analytics`)*

### `/settings` — Payout & settings
- [x] Membership / tier status card; Payout (Tipalti) status card
- [x] Payout unlock (**#16**) — "Set up payouts" prompt unlocks once settled cash ≥ $50 (`getCreatorCash`)
- [x] Fee defaults — **read-only info** per **B9** *(but see open decision #17 below)*

### `/join` — Membership upsell
- [x] CP-framed upsell (**B1**), capability comparison, CTA; CP-member redirect to `/`; reusable `JoinUpsell`; nav aligned to CP membership

---

## Open — needs a product decision (Justin)
- 🟢 **#17 — Fee defaults: read-only vs. editable + "apply to all"?** Justin expected the settings section to *set* a default rate + a bulk-apply button; **B9** decided fixed system defaults (read-only). Reconcile — is B9 being reversed? ([feedback #17](feedback-justin-round-2.md))
- 🟢 **#23 — Early-access reframing.** Allow *enabling* EA on an already-published model from the studio, or only *manage* when already on / enable-at-publish? *(Cheap pre-check available: does `POST /api/v1/model-versions/early-access` even allow enabling on a published version?)* ([feedback #23](feedback-justin-round-2.md))
- 🟢 **B13 — Publish / schedule a version in v1?** Recommended default: fast-follow (not v1). ([decisions B13](pre-implementation-decisions.md))

## Blocked — backend / main-app dependency
- 🚧 **A1 Part 2 — owner-keyed `modelVersionId→ownerUserId` dictionary (Koen / CDC).** Unblocks per-model earnings, `/analytics` model section (generations/downloads/top-models), and the dashboard top-earning-models widget. Ask is written: [cdc-koen.md](cdc-koen.md). **In-spoke fallback is viable now** (Postgres version-ids → `IN()` over pre-aggregated daily MVs; ~820ms for a 349-version creator, capped for mega-creators) — see "Deferred" below.
- 🚧 **A4 — Sell access indefinitely.** Reuse early-access uncapped; needs the main-app representation (nullable `timeframe`/`indefinite` flag). Write path already exists (the B12 endpoint). ([decisions A4](pre-implementation-decisions.md))
- 🚧 **`licenseFee` type is `'27'` (ingest bug, Justin owns).** We filter `type IN ('licenseFee','27')` until the MV fix + backfill lands, then drop `'27'`. ([owner-rollup-handoff §🔴](owner-rollup-handoff.md))
- 🚧 **B4 — owner-keyed daily SummingMergeTree MVs (perf, not correctness).** The content-analytics 90-day reads scan raw event tables (cached, but heavy). Backend MVs would remove the raw-scan load. Not blocking any feature. ([feedback #10](feedback-justin-round-2.md))

## Flagged bugs — upstream (shape the numbers, not ours to fix)
- 🐛 **Access sales always credit yellow** — confirmed bug; fix is forward-only, historical rows stay yellow. ([owner-rollup-handoff §D1](owner-rollup-handoff.md))
- 🐛 **Cosmetic creator payouts are best-effort** — a failed payout leaves no row, so `/earnings` can under-report cosmetic revenue with no signal. ([owner-rollup-handoff §payment-path bugs](owner-rollup-handoff.md))
- 🐛 **ClickHouse `buzzTransactions` mirror gap** — CH showed a pending-cash balance the buzz service didn't; flag to whoever owns the buzz→CH sync. Doesn't affect the studio (cash reads go to the buzz service).

## Deferred / unblocked builds (buildable when prioritized)
- ⏭ **Model analytics via the in-spoke fallback** — Postgres version-ids → `IN()` over `daily_resource_generation_counts` / `daily_downloads` / `buzz_resource_compensation`, capped by version count, Redis-cached. Ships per-model usage/earnings + top-models for small/moderate creators *now*; swap the read to the A1 dictionary when it lands (UI/contract unchanged). *(Scoped + measured; paused by request.)*
- ⏭ **#24 — Bulk "select all matching" + base-model filter** (`/models`) — highest-value remaining bulk-fee build. ([feedback #24](feedback-justin-round-2.md))
- ⏭ **#11 — Synchronized crosshair across charts** — needs a Chart.js plugin + shared hover store (add a `plugins` prop to the `Chart` wrapper first). ([feedback #11](feedback-justin-round-2.md))
- ⏭ **#4 — Dashboard charts** — low priority. ([feedback #4](feedback-justin-round-2.md))
- ⏭ **Access-config drawer URL-addressable** (`?version=` shallow routing) — `/models` polish.
- ⏭ **Lifetime "total comments received" stat** — fast (`image_metrics_user`), but lifetime-only (doesn't fit the period-scoped page).
