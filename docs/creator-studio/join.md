# `/join` — Membership upsell ✓

> **v1.** The surface shown to **non-members** (any logged-in user can reach the Studio — the door gate is
> "authenticated," not member — [plan §1](../creator-studio-plan.md#1-what-this-app-is)). It sells the member-gated
> capabilities (**setting a licensing fee**, **sell access indefinitely**) and links out to subscribe / join. Read-only:
> the CTA links out, we don't rebuild billing or CP enrollment here.

## User story

As a logged-in **non-member**, I open the Studio and can look around, but the money-making controls are disabled. When
I hit `/join` (or click a disabled control on [models.md](models.md) / [licensing.md](licensing.md)), I see **what
Creator Program membership unlocks** and a single CTA to **join the Creator Program** — which takes me to the existing
main-app flow.

## Layout & components

`@civitai/ui` (shadcn-svelte) primitives — don't hand-build:

- **`card`** — one value-prop card per unlocked capability (set licensing fees · sell access indefinitely) and a
  **member-vs-non-member comparison** card (what each can do).
- **`button`** — the single primary **join the Creator Program** CTA (links out — see Actions); **`badge`** for
  "Creator Program" membership state; **`separator`** between prop groups.
- Copy is fixed: the gate is **Creator Program membership**, so the CTA reads "join the Creator Program" (not
  "subscribe to a plan").

## Data (reads) — `+page.server.ts`

Read-only, from `locals.user` (kysely via `@civitai/db`), scoped to the current user:

- **Confirm the user is not a Creator Program member** — via `creatorProgram.getCreatorRequirements` (CP membership is
  the single gate) ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)); if they're
  already a member, `/join` redirects to `/` (nothing to upsell).
- **What to show** — the value props and member-vs-non-member comparison content (static config).
- **No writes, no ClickHouse, no buzz call** — this page only reads current-user membership state.

## Actions (writes) — none (CTA links out)

There are **no form actions**. The subscribe / join CTA is a link to the **existing main-app billing or Creator Program
flow** — we do **not** rebuild billing or CP enrollment ([plan §5.2](../creator-studio-plan.md#52-reuse-existing-main-app-endpointsservices)).
Whether that's an in-app redirect or an out-to-main-app link is an open question below.

## States

- **Non-member** — the default and only meaningful state: value props + member-vs-non-member comparison + CTA.
- **Already a member** — redirect to `/` (or the section they came from); `/join` has nothing to say to members.
- **Inline upsell** — when reused as a card/tooltip/modal on a gated control, it renders the same value prop + CTA in a
  compact form (see Shared/cross-refs).

## Gating

Inverse of the rest of the Studio: `/join` is the surface **for** non-members. The nav item is member-aware — hidden or
de-emphasised for members via the shared `nav.ts` `memberOnly` mechanism ([plan §3](../creator-studio-plan.md#3-page-list-v1)).
The capabilities it sells (fee-setting, sell-indefinitely) are the Creator Program membership-gated ones enforced on
[models.md](models.md) / [licensing.md](licensing.md) and re-checked server-side in the monetization module.

## Shared / cross-refs

- **The gated-control upsell** — non-members hitting a disabled fee / sell-indefinitely control on
  [models.md](models.md) (§Gating) and [licensing.md](licensing.md) get an **upsell tooltip / link to `/join`**. `/join`
  is likely **both** a standalone page **and** an inline surface (card/tooltip/modal) reused across those pages — the
  value-prop + CTA block should be one shared component so the message can't drift.
- **Settings** — Creator Program membership status also lives on [settings.md](settings.md); `/join` is the
  *acquisition* surface, settings is the *status* surface.
- **Nav** — member-aware item via app-local `nav.ts` ([plan §3](../creator-studio-plan.md#3-page-list-v1)).

## Decisions (resolved 2026-07-02)

- **JOIN-1 — Gate.** The gate is **Creator Program membership** (one bar for all gated actions). Copy reads "join the
  Creator Program," not "subscribe to a plan."
- **JOIN-2 — In-app vs redirect.** CP enrollment is lightweight, so users who **already have a membership** join
  **in-app** (no bounce to the main site). Users **without a membership** can't join CP yet, so upsell them to buy a
  membership first (link out — see JOIN-3).
- **JOIN-3 — What to show.** Don't sell memberships on-site. For membership purchase, point users to the **main-app
  pricing page**; they pick a plan and come back. On-site join is only for users who already hold a membership.
- **JOIN-4 — Surface shape.** Both an **interstitial** and inline **alerts**. Gated charts get an overlay ("you have to
  be a program member for this"); attempting a gated action (e.g. setting a licensing fee) throws a **modal** that
  explains the gate and points to the `/join` interstitial. Keep the value-prop + CTA block as one shared component so
  the message can't drift.

**Still open / deferred:** the main-app pricing page + purchase flow needs a **return-URL / message control** so users
land back in the Studio after buying a membership (JOIN-2/JOIN-3).
