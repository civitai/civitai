# `/settings` — Payout & settings

> **v1.** The creator's account-level control surface: **payment config (Tipalti) status**, **Creator Program
> membership status**, and a **default fee-suggestion** preference.
> Umbrella: [plan §3](../creator-studio-plan.md#3-page-list-v1). Mostly **read + link-out**; a few small preference
> writes go through the creator-studio module ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)).

## User story

As a creator, I open `/settings` and see at a glance whether I'm **set up to get paid** (Tipalti onboarding done or
not) and whether my **Creator Program membership** is active. I don't re-do onboarding or billing here — I click out
to the existing flows. I *do* set my **default fee suggestion** here (the per-account baseline), so `/models` starts from
my baseline instead of the global default. (**Settlement currency isn't a creator choice** — Civitai handles cash
settlement in special cases.)

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one status card per concern: **Payout** (Tipalti), **Membership** (Creator Program), each with a
  **`badge`** (`Set up` / `Not set up` / `Active` / `Lapsed`) and a **`button`** linking out (Membership → the main-app
  pricing page; Payout → `/tipalti/setup`).
- **`separator`** between the read-only status block and the editable prefs block.
- **`input`** + **`label`** for the **default fee suggestion**; **`button`** to save.
- **`sonner`** (toast) for save success/failure; **`tooltip`** for the gated/lapsed explanations.
- Member-gated prefs render **disabled with an upsell tooltip** for non-members (link to [./join.md](./join.md)).

## Data (reads) — `+page.server.ts`

Loaded server-side (kysely via `@civitai/db`), scoped to `locals.user.id`:

- **Payout config** — `UserPaymentConfiguration` (Tipalti onboarding / payout-method status)
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)). Read-only here. The Tipalti
  setup gate is **settled cash ("Ready to Withdraw") >= $50** (not pending), so copy reads **"$50 Ready to Withdraw."**
- **Creator Program membership** — via `creatorProgram.getCreatorRequirements`; drives whether the fee prefs are enabled
  and what the Membership card shows ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **CP cash / banked** (if the withdrawal entry lives here) — `creatorProgram.getCash` / `getBanked`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
- **Current defaults** — the creator's saved fee-suggestion pref (see writes).
- **Not** an analytics page — no ClickHouse here. Earnings live on [./earnings.md](./earnings.md).

## Actions (writes) — form actions → monetization module

Only the small **preference** writes; onboarding/billing/withdrawal are **link-outs**, not writes here. Prefs go
through the creator-studio **monetization module** ([plan §5.3](../creator-studio-plan.md#53-new-monetization-operations-creator-studio-module-extract-to-a-package-at-consolidation)):

| Action | Op | Notes |
|---|---|---|
| Set default fee suggestion | (account-pref write) | Creator Program members only; overrides the model-type default (`getDefaultFeeSuggestions`) as the creator's per-account baseline. |

- **Authorization asserted inside the module** on member-gated prefs — the disabled control is UX, the server
  re-checks Creator Program membership.
- **Ownership** is implicit (`locals.user.id`), but every write is scoped to it explicitly.
- **No buzz call, no ClickHouse** — these are plain account-pref writes.

## States

- **Loading** — `skeleton` cards.
- **Payout not set up** — Payout card shows `Not set up` + a prominent "Set up payouts" button → the embedded Tipalti
  setup at `/tipalti/setup` (creators are invited once settled cash is **>= $50 Ready to Withdraw**).
- **Non-member** — Membership card shows the upsell → [./join.md](./join.md); the fee-suggestion pref is **disabled**
  with an upsell tooltip.
- **Membership lapsed** — Creator Program membership inactive: Membership card shows `Lapsed`; note that any set fees are
  **paused** (value retained) per [plan §7.1](../creator-studio-plan.md#71-schema--data-main-app-db), with a link to [./models.md](./models.md).
- **Error** — inline field error + toast; optimistic pref update rolls back on failure.

## Gating

**Creator Program membership** gates the **default fee suggestion** pref (it's a fee action). Payout/membership status
and settlement currency are visible to any authenticated user. Enforced both in UI (disabled + tooltip) and in the
module (server re-check).

## Shared / cross-refs

- **Do not rebuild** Tipalti onboarding or subscription billing — link out to the existing main-app / Creator Program
  flows ([plan §6.2](../creator-studio-plan.md#62-redirect-superseded-management-surfaces)).
- **Settlement currency is not a creator setting** (Justin) — Civitai does cash settlement only in special cases, on the
  creator's behalf; there's no per-account or per-version control on [./models.md](./models.md).
- **Cash withdrawal home is [./earnings.md](./earnings.md)** (single entry point) — settings only shows payout-setup
  status. For v1 the withdrawal flow links out to the existing CP path, not rebuilt here.
- Nav item is not member-gated (settings is reachable by any authenticated user) via the shared `nav.ts`.

## Decisions (resolved 2026-07-02)

- **SET-1 — Tipalti: editable here vs link-out.** **v1 = link out.** A creator is invited to set up Tipalti (embedded
  iframe at `/tipalti/setup`) once their **settled** cash is **>= $50 "Ready to Withdraw"** (not pending). Copy must say
  **"$50 Ready to Withdraw."** v1 link-out targets: `/tipalti/setup` (set up payouts), `/user/buzz-dashboard` (withdraw),
  `/user/account#payments` (account status), `/creator-program` (FAQ/join) — link only the Creator Program V2 cash flow.
  If CP banking is ported later, bring the Tipalti setup into the Studio.
- **SET-2 — Default fee: per-account vs per-version.** **Settings owns the per-account baseline**; [./models.md](./models.md)
  overrides per version. Values LoRA ~0.1, base ~1 buzz/image (see PLAN-11 for the model-type exclusion set).
- **SET-3 — Membership upgrade/cancel.** **Link out** to the main-app pricing page (return control brings them back to
  the Studio); status shown here only.
- **SET-4 — Cash withdrawal home.** **[./earnings.md](./earnings.md)** — single entry point.
- **SET-5 — Gate.** **Creator Program membership.** The Membership card reports CP status; the fee-pref gate is CP.

**Still open / deferred:** porting the full CP banking/withdrawal experience into the Studio (Tipalti setup + withdraw
inline) is a **later** upgrade; v1 links out.
