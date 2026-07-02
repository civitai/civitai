# `/settings` — Payout & settings

> **v1.** The creator's account-level control surface: **payment config (Tipalti) status**, **membership/`tier`
> status**, and a **default fee-suggestion** preference.
> Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1). Mostly **read + link-out**; a few small preference
> writes go through the creator-studio module ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).

## User story

As a creator, I open `/settings` and see at a glance whether I'm **set up to get paid** (Tipalti onboarding done or
not) and whether my **membership** is active and at what `tier`. I don't re-do onboarding or billing here — I click out
to the existing flows. I *do* set my **default fee suggestion** here, so `/models` and `/licensing` start from my baseline instead of the
global default. (**Settlement currency isn't a creator choice** — Civitai handles cash settlement in special cases.)

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one status card per concern: **Payout** (Tipalti), **Membership** (`tier`), each with a **`badge`**
  (`Set up` / `Not set up` / `Active` / `Lapsed`) and a **`button`** linking out.
- **`separator`** between the read-only status block and the editable prefs block.
- **`input`** + **`label`** for the **default fee suggestion**; **`button`** to save.
- **`sonner`** (toast) for save success/failure; **`tooltip`** for the gated/lapsed explanations.
- Member-gated prefs render **disabled with an upsell tooltip** for non-members (link to [./join.md](./join.md)).

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id`:

- **Payout config** — `UserPaymentConfiguration` (Tipalti onboarding / payout-method status)
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)). Read-only here.
- **Membership `tier`** — `CustomerSubscription → Product.metadata.tier` (bronze/silver/gold); drives whether the fee
  prefs are enabled and what the Membership card shows ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **CP cash / banked** (if the withdrawal entry lives here) — `creatorProgram.getCash` / `getBanked`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **Current defaults** — the creator's saved fee-suggestion pref (see writes).
- **Not** an analytics page — no ClickHouse here. Earnings live on [./earnings.md](./earnings.md).

## Actions (writes) — form actions → monetization module

Only the small **preference** writes; onboarding/billing/withdrawal are **link-outs**, not writes here. Prefs go
through the creator-studio **monetization module** ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)):

| Action | Op | Notes |
|---|---|---|
| Set default fee suggestion | (account-pref write) | member-only; overrides the model-type default (`getDefaultFeeSuggestions`) as the creator's baseline. |

- **Authorization asserted inside the module** on member-gated prefs — the disabled control is UX, the server
  re-checks the `tier`.
- **Ownership** is implicit (`locals.user.id`), but every write is scoped to it explicitly.
- **No buzz call, no ClickHouse** — these are plain account-pref writes.

## States

- **Loading** — `skeleton` cards.
- **Payout not set up** — Payout card shows `Not set up` + a prominent "Set up payouts" button → main-app / CP Tipalti
  onboarding.
- **Non-member** — Membership card shows the upsell → [./join.md](./join.md); the fee-suggestion pref is **disabled**
  with an upsell tooltip.
- **Membership lapsed** — `tier` inactive: Membership card shows `Lapsed`; note that any set fees are **paused** (value
  retained) per [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db), with a link to [./models.md](./models.md).
- **Error** — inline field error + toast; optimistic pref update rolls back on failure.

## Gating

Member-`tier` gates the **default fee suggestion** pref (it's a fee action). Payout/membership status and settlement
currency are visible/editable to any authenticated user. Enforced both in UI (disabled + tooltip) and in the module
(server re-check). Exact bar (tier vs full CP) pending ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)).

## Shared / cross-refs

- **Do not rebuild** Tipalti onboarding or subscription billing — link out to the existing main-app / Creator Program
  flows ([plan §6.2](../creator-studio-plan.md#62-redirect-superseded-management-surfaces)).
- **Settlement currency is not a creator setting** (Justin) — Civitai does cash settlement only in special cases, on the
  creator's behalf; there's no per-account or per-version control on [./models.md](./models.md).
- **Cash withdrawal** may surface here or on [./earnings.md](./earnings.md); either way the flow itself is the CP
  withdrawal path, not rebuilt here.
- Nav item is not member-gated (settings is reachable by any authenticated user) via the shared `nav.ts`.

## Open questions

- **Editable here vs link-out** — is Tipalti setup *initiated* here (embedded/deep-link) or purely a status card that
  links to the main-app onboarding? Default assumption: status + link-out.
- **Default fee suggestion — per-account vs per-version** — confirm this page owns the per-account baseline and
  [./models.md](./models.md) inherits/overrides per version. *(Settlement currency is resolved — not a creator choice.)*
- **Membership upgrade/cancel** — done here or link out to billing? Default: link out; show status only.
- **Cash withdrawal home** — here, on [./earnings.md](./earnings.md), or purely the CP flow? Pick one to avoid two
  entry points.
- **Tier-vs-CP gate** ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)) — changes what the Membership
  card reports (subscription `tier` alone vs tier + creator-score CP membership) and the fee-pref gate.
