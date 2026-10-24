# `/settings` — Payout & settings

> **v1.** The creator's account-level control surface: **payment config (Tipalti) status**, **membership/`tier`
> status**, and a **read-only** default fee-suggestion panel.
> Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1). **Read + link-out only** — the page has no writes.

## User story

As a creator, I open `/settings` and see at a glance whether I'm **set up to get paid** (Tipalti onboarding done or
not) and whether my **membership** is active and at what `tier`. I don't re-do onboarding or billing here — I click out
to the existing flows. I can *see* the **fee suggestion** the form will seed for each model type, but I don't set it here —
**B9** kept that a fixed system value, and my own defaults are named templates instead
([pricing-templates.md](monetization/pricing-templates.md)). (**Settlement currency isn't a creator choice** — Civitai handles cash
settlement in special cases.)

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one status card per concern: **Payout** (Tipalti), **Membership** (`tier`), each with a **`badge`**
  (`Set up` / `Not set up` / `Active` / `Lapsed`) and a **`button`** linking out.
- **`separator`** between the status cards and the fee-suggestion panel.
- Read-only display of the per-model-type **fee suggestion** (`suggestedFee`). No input, no save — see the user story.
- **`tooltip`** for the lapsed-membership explanation.

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id`:

- **Payout config** — `UserPaymentConfiguration` (Tipalti onboarding / payout-method status)
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)). Read-only here.
- **Membership `tier`** — `CustomerSubscription → Product.metadata.tier` (bronze/silver/gold); drives what the
  Membership card shows ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **CP cash / banked** (if the withdrawal entry lives here) — `creatorProgram.getCash` / `getBanked`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **Not** an analytics page — no ClickHouse here. Earnings live on [./earnings.md](./earnings.md).

## Actions (writes)

**None.** Onboarding, billing and withdrawal are link-outs. The one write this page was specced to own — setting a
per-account fee default — was decided against by **B9**, which kept the suggestion a fixed system value; creator-authored
defaults are named templates on their own route instead ([pricing-templates.md](monetization/pricing-templates.md)).

## States

- **Loading** — `skeleton` cards.
- **Payout not set up** — Payout card shows `Not set up` + a prominent "Set up payouts" button → main-app / CP Tipalti
  onboarding.
- **Non-member** — Membership card shows the upsell → [./join.md](./join.md).
- **Membership lapsed** — `tier` inactive: Membership card shows `Lapsed`; note that any set fees are **paused** (value
  retained) per [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db), with a link to [./models.md](./models.md).
- **Error** — a failed status read degrades to the card's `Not set up` / unknown state rather than blocking the page.

## Gating

Nothing on this page is member-gated: with the fee-suggestion pref gone (**B9**), what remains is payout and membership
status, both visible to any authenticated user. The tier gate that was specced here belongs to whatever surface actually
writes a fee — the bulk bar on [./models.md](./models.md), and the templates route when it ships.

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
- **Membership upgrade/cancel** — done here or link out to billing? Default: link out; show status only.
- **Cash withdrawal home** — here, on [./earnings.md](./earnings.md), or purely the CP flow? Pick one to avoid two
  entry points.
- **Tier-vs-CP gate** ([plan §9](../creator-studio-plan.md#9-decisions--open-questions)) — changes what the Membership
  card reports: subscription `tier` alone vs tier + creator-score CP membership.
