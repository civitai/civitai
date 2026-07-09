# `/join` — Membership upsell ✓

> **v1.** The surface shown to **non-members** (any logged-in user can reach the Studio — the door gate is
> "authenticated," not member — [plan §1](../creator-studio-plan.md#1-what-this-app-is)). It sells the member-gated
> capabilities (**setting a licensing fee**, **sell access indefinitely**) and links out to subscribe / join. Read-only:
> the CTA links out, we don't rebuild billing or CP enrollment here.

## User story

As a logged-in **non-member**, I open the Studio and can look around, but the money-making controls are disabled. When
I hit `/join` (or click a disabled control on [models.md](models.md) / [licensing.md](licensing.md)), I see **what the
member tier unlocks** and a single CTA to **subscribe / join** — which takes me to the existing main-app flow.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one value-prop card per unlocked capability (set licensing fees · sell access indefinitely) and a
  **tier-comparison** card (member vs non-member: what each can do).
- **`button`** — the single primary **subscribe / join** CTA (links out — see Actions); **`badge`** for the tier name
  (bronze/silver/gold) or "Creator Program"; **`separator`** between prop groups.
- Copy is **gate-dependent**: "subscribe to a plan" vs "join the Creator Program" hinges on the pending confirm below —
  the CTA target and headline change with it.

## Data (reads) — `+page.server.ts`

Read-only, from `locals.user` (kysely via `@civitai/db`), scoped to the current user:

- **Confirm the user is a non-member** — the member `tier` via `CustomerSubscription → Product.metadata.tier`
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)); if they're already a member,
  `/join` redirects to `/` (nothing to upsell).
- **Which tiers / plans to show** — the value props and tier-comparison content (static config or the same tier source).
- **No writes, no ClickHouse, no buzz call** — this page only reads current-user membership state.

## Actions (writes) — none (CTA links out)

There are **no form actions**. The subscribe / join CTA is a link to the **existing main-app billing or Creator Program
flow** — we do **not** rebuild billing or CP enrollment ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
Whether that's an in-app redirect or an out-to-main-app link is an open question below.

## States

- **Non-member** — the default and only meaningful state: value props + tier comparison + CTA.
- **Already a member** — redirect to `/` (or the section they came from); `/join` has nothing to say to members.
- **Inline upsell** — when reused as a card/tooltip/modal on a gated control, it renders the same value prop + CTA in a
  compact form (see Shared/cross-refs).

## Gating

Inverse of the rest of the Studio: `/join` is the surface **for** non-members. The nav item is member-aware — hidden or
de-emphasised for members via the shared `nav.ts` `memberOnly` mechanism ([plan §3](../creator-studio-plan.md#3-page-list-v1)).
The capabilities it sells (fee-setting, sell-indefinitely) are the member-`tier`-gated ones enforced on
[models.md](models.md) / [licensing.md](licensing.md) and re-checked server-side in the monetization module.

## Shared / cross-refs

- **The gated-control upsell** — non-members hitting a disabled fee / sell-indefinitely control on
  [models.md](models.md) (§Gating) and [licensing.md](licensing.md) get an **upsell tooltip / link to `/join`**. `/join`
  is likely **both** a standalone page **and** an inline surface (card/tooltip/modal) reused across those pages — the
  value-prop + CTA block should be one shared component so the message can't drift.
- **Settings** — membership / `tier` status also lives on [settings.md](settings.md); `/join` is the *acquisition*
  surface, settings is the *status* surface.
- **Nav** — member-aware item via app-local `nav.ts` ([plan §3](../creator-studio-plan.md#3-page-list-v1)).

## Open questions

- **⚠️ Tier vs full-CP gate (headline).** Is "member" an **active subscription `tier`** (bronze/silver/gold) or **full
  Creator Program membership** (tier **+** creator score ≥40k)? This directly changes the CTA and copy — "subscribe to a
  plan" vs "join the Creator Program" (the latter needs score ≥40k, a stricter bar). Pending confirm
  ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices), [plan §9](../creator-studio-plan.md#9-decisions--open-questions)).
- **In-app vs redirect.** Does subscribe / enroll happen in-app or redirect to the main app's billing / CP flow (and do
  we deep-link back to the Studio afterward)?
- **Which tiers + value props to display** — all three subscription tiers with a comparison, or just the minimum bar
  that unlocks the gated controls?
- **Standalone page, interstitial, or both** — is `/join` a full page, an interstitial shown when a gated action is
  attempted, or both — and how is the shared gating/upsell surface reused across [models.md](models.md) and
  [licensing.md](licensing.md) without drift?
