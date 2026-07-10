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
- [ ] Analytics reads module (ClickHouse) — **🚧 A1** owner-keyed rollup
- [ ] Charting library decision (**C1**) — needed for analytics / earnings / dashboard trends

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
- [ ] Retire / redirect the standalone `/licensing` route stub to `/models?mode=bulk`

---

## `/` — Dashboard
- [x] Shell: headline stat cards (placeholders) + section link cards + member badge
- [ ] Earnings summary by source — **🚧 A1** owner-keyed rollup
- [ ] CP cash pending / settled (`getCash` / `getBanked`)
- [ ] Top-earning models widget — **🚧 A1**
- [ ] Replace placeholder skeletons with real numbers

---

## `/earnings` — Earnings by source
- [ ] By-source breakdown (comp / license / tip) — **🚧 A1**
- [ ] Access-sale + cosmetic-sale sources — **🚧 A5**
- [ ] Time-series chart — **🚧 C1**
- [ ] CP cash panel + Withdraw link-out
- *(route stub only)*

---

## `/earnings/analytics` — Basic analytics
- [ ] Model section: generations / downloads over time, top-models — **🚧 A1 + C1**
- [ ] Content/creator section: reactions, followers, posts, profile views (B4) — **🚧** owner-keyed MVs + C1
- [ ] Date-range control (presets)
- *(route stub only)*

---

## `/settings` — Payout & settings
- [ ] Payout (Tipalti) status card
- [ ] Membership / tier status card
- [ ] Default fee-suggestion preference
- *(route stub only)*

---

## `/join` — Membership upsell
- [x] Upsell page (value-prop cards) + already-member redirect to `/`
- [ ] Final tier-comparison + CTA copy in the **Creator Program** framing (B1)
- [ ] Reusable inline upsell (card/tooltip on gated controls)
