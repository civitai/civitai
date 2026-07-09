# Creator Studio — Overview

A new SvelteKit spoke app at **`creator.civitai.com`** — the single home for managing everything a creator earns from
(licensing fees, model access, earnings & analytics). Any logged-in user can access it; member-only actions are gated on
subscription `tier`.

Full plan: [creator-studio-plan.md](creator-studio-plan.md).

## Packages

**New package — just one:**
- **`@civitai/buzz`** (**built**) — server-side client for the buzz service (transactions, balances, typed endpoint methods). Lifted out of `buzz.service.ts`. Server-only. *(Not the analytics path — see ClickHouse below.)*

**Creator-studio modules (in-app, NOT packages — extract only when a 2nd app needs them):**
- **monetization** — `setLicensingFee`, `bulkSetLicensingFee`, `setUnlimitedAccess`, member-`tier` gate. On `@civitai/db` (kysely) + `@civitai/buzz`. No stacking (backend), no ClickHouse. → package at the full-cutover consolidation.
- **analytics reads** — ClickHouse queries via `@civitai/clickhouse`.

**Existing packages — consumed:**
- **`@civitai/ui`** — shadcn-svelte components + theme
- **`@civitai/auth`** — spoke guard (any authenticated user; tier read for member gating)
- **`@civitai/db`** (+ `@civitai/db-schema`) — kysely reads/writes
- **`@civitai/clickhouse`** — **required**: all analytics/earnings read from ClickHouse (daily aggregates / materialized views), not the buzz service

## Pages

**v1:**
- `/` — Dashboard / overview
- `/models` ⭐ — Model management (access toggles, per-version licensing fee, sell-indefinitely)
- `/earnings/analytics` ⭐ — Basic analytics
- `/earnings` — Earnings by source (via `@civitai/buzz`)
- `/licensing` — Licensing fees (bulk editor)
- `/settings` — Payout & settings (Tipalti status, tier)
- `/join` — Membership upsell (for non-members)

**Deferred (not v1):**
- `/shop`, `/shop/items/[id]` — Shop management (built in the main app first, transfers in later)

⭐ = designer-prioritised for v1.
