# Creator Studio — implementation checklist

Per-page progress tracker. Feature detail lives in the page specs; blockers/decisions in
[pre-implementation-decisions.md](pre-implementation-decisions.md).

Legend: `[x]` done · `[ ]` not started · **🚧** blocked on a dependency · **⏭** deferred / 2nd-priority.

---

## Shared / shell
- [x] App scaffold (SvelteKit spoke), auth gate, nav, layout, favicon
- [x] Membership resolver (Creator Program gate) + moderator test simulator (`cs-test-membership` cookie)
- [x] Monetization module — `setLicensingFee` / `bulkSetLicensingFee` / apply-default-by-type (kysely); early-access write client (calls the main-app REST endpoint, forwards session cookie)
- [x] Axiom logging (`handleError` hook)
- [~] Analytics reads module (ClickHouse) — content/creator metrics **done** (userId-keyed, no A1 needed; `src/lib/server/analytics.ts`); model-usage/earnings metrics still **🚧 A1** owner-keyed rollup
- [x] Redis read-through cache (`@civitai/redis` `createRedisCacheBuilder` / `createSysRedisCacheBuilder` → spoke `cache.ts`); analytics reads cached with range-scaled TTL (7d ~5m / 30d ~15m / 90d ~1h)
- [x] Charting primitive (**C1**) — **Chart.js** in-house `Chart` wrapper in `@civitai/ui` (SSR-safe; `chartColor()` bridges the theme palette). Chose it over LayerChart (that ships un-preprocessed TS → build fails; Chart.js also matches the main app). Placeholder chart live on `/earnings/analytics`.

---

## `/models` — Model management ⭐
- [x] Grouped table: models → versions nested, drafts included
- [x] Set / adjust / clear licensing fee — single, inline, fractional (0.01), CP-gated
- [x] Bulk fee editing (`?mode=bulk`) — per-version + per-model select-all, confirm dialog
- [x] Apply default fee by model type (bulk)
- [x] Fee status: Off / Active / Paused
- [x] Non-commercial base-model guard (rejects monetizing e.g. Ideogram)
- [x] Ownership + CP gate re-checked server-side (not just disabled UI)
- [x] Search / fee filter / sort / pagination — URL-driven
- [x] States: empty, filtered-empty, non-member notice, error toasts
- [x] Edit full early/paid-access config (duration, download/generation price, trials, free-gen, donation goal) — full parity (Q1), in a per-version drawer; writes via the merged main-app endpoint `POST /api/v1/model-versions/early-access`
- [ ] Sell access indefinitely — **🚧 A4** (no main-app representation yet)
- [ ] Publish / schedule — **⏭** 2nd priority
- [ ] Make the access-config drawer URL-addressable (`?version=` shallow routing) — polish; drawer currently opens via local state
- [ ] Skeleton loading + optimistic updates (optional)

---

## Licensing — bulk fees
- [x] **Implemented as `/models?mode=bulk`** (C2 decision — not a separate page). Bulk set/clear + apply-default covered above.
- [x] Dropped the standalone `/licensing` route stub (+ its nav item, dashboard card, and orphaned `license` icon) — bulk lives under Models

---

## `/` — Dashboard
- [x] Shell: headline stat cards + section link cards + member badge
- [x] Content-activity row — real 30-day reactions / followers / images / posts / profile views (`getContentTotals`, userId-keyed, Redis-cached)
- [x] Buzz earned (30d, `buzzTransactions`) + CP cash cards (ready / pending / withdrawn, authoritative via `@civitai/buzz`)
- [ ] Top-earning models widget — **🚧 A1 Part 2** (owner-keyed dictionary, Koen/CDC)

---

## `/earnings` — Earnings by source
- [x] By-source breakdown (comp / license / tip / access / cosmetic) — **A1 Part 1**: reads `buzzTransactions` directly (already owner-keyed, no rollup); `licenseFee`+`'27'` filter, early-access prefix
- [x] Access-sale + cosmetic-sale sources — folded into the same read (A5 needs no new MV; cosmetic = `sell`, access = `purchase`+`early-access-`)
- [x] Time-series chart — buzz-only per-currency trend (Chart.js), real buzz colors; Redis-cached
- [x] Per-currency faithful display (B8/D1: no conversion/merge) — currency cards + source×currency table
- [x] CP cash panel — **authoritative** ready / pending / withdrawn (buzz service via `@civitai/buzz` + `CashWithdrawal` query), USD (cents÷100), matches the Buzz dashboard to the cent; Buzz Dashboard link-out
- [x] `@civitai/buzz` wired into the spoke (shim + `BUZZ_ENDPOINT`); cash read is NOT from ClickHouse (mirror/flow) — see the owner-rollup-handoff discussion
- [ ] Per-model earnings breakdown — **🚧 A1 Part 2** (owner-keyed dictionary, Koen/CDC)

---

## `/earnings/analytics` — Basic analytics
- [ ] Model section: generations / downloads over time, top-models — **🚧 A1 + C1**
- [x] Content/creator section (B4): reactions, followers, images, posts, profile views over time + top-images table (userId-keyed, no A1 needed); Chart.js line charts; Redis-cached
- [x] Date-range control — 7/30/90-day presets + day/week granularity toggle (URL-driven)

---

## `/settings` — Payout & settings
- [x] Membership / tier status card — reads session (`tier` + CP membership); links to `/pricing` + `/creator-program`
- [x] Payout (Tipalti) status card — reads `UserPaymentConfiguration` (active / pending / not set up); links out to the Buzz dashboard
- [x] Payout unlock (**#16**) — when not-set-up, the "Set up payouts" prompt unlocks once settled cash ≥ $50 (`getCreatorCash`), so we don't push creators into Tipalti signup (billed per account) before they can withdraw
- [x] Fee defaults — **read-only info** (B9 made a per-account pref moot: fixed seed values — Checkpoint 1, LoRA 0.1)
- [x] CP cash panel + Withdraw — landed on `/earnings` (C6: one cash home)

---

## `/join` — Membership upsell
- [x] Upsell page (value-prop cards) + CP-member redirect to `/` (B1 gate, not subscription tier)
- [x] Final capability-comparison + CTA copy in the **Creator Program** framing (B1) — perks, member-vs-everyone table, requirement note (active membership + creator score ≥ 40k), CTA → `civitai.com/creator-program`; tailored for paying-but-not-CP vs non-member
- [x] Reusable inline upsell (`JoinUpsell` component) — used on `/models`; links to `/join`
- [x] Nav aligned to CP membership (B1) — `/join` item + member badges now key on `isCreatorProgramMember`, not subscription tier
