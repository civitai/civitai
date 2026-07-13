# Creator Studio scope vs. Creator Program perks

A gap-check between **what the Creator Studio app is scoped to offer** and **what
[civitai.com/creator-program](https://civitai.com/creator-program) advertises as Creator Program member perks**
(source: `src/pages/creator-program/index.tsx`). Written to make sure the Studio's `/join` upsell isn't
over/under-claiming, and to keep the two surfaces' responsibilities clear.

## TL;DR

They're **complementary, not overlapping**:

- **The Creator Program page sells the *program*** — the money pipeline: **earn Buzz → bank it → withdraw real
  cash.** Its perks are almost entirely about *cashing out*.
- **The Creator Studio is the creator's *control panel + insight*** for the monetization levers that *feed* that
  pipeline (set fees, early/paid access, sell indefinitely) plus visibility (earnings, analytics, payout status).
- **The Studio does not — and should not — rebuild banking/withdrawal.** Those stay on the main-app Buzz
  dashboard / CP page; the Studio **links out** for them.

So most CP "perks" live on the earn-and-cash-out side (main app), while the Studio owns the *controls and
insight* around the "earn" step.

---

## Creator Studio vs. the main site (for Creator Program members)

Same ✓/✗ style as the `/join` table, but the axis is **where a Creator Program member does each thing** — the
Studio app vs. civitai.com. The **Creator Studio** column is what the app is *scoped* to own (built-vs-planned in
Notes); the **Main site** column is what exists on civitai.com today.

### Monetization controls (the levers that earn Buzz)

| Capability | Creator Studio | Main site | Notes |
|---|---|---|---|
| Set / adjust a version's licensing fee | ✓ | ✓ | Main = inline on the model-version form, until model management is deprecated there |
| **Bulk** licensing-fee editing | ✓ | ✗ | Studio-only — the point of the tool |
| Edit early / paid access config | ✓ | ✓ | Studio writes via the shared main-app endpoint |
| Sell access indefinitely | ✓ | ✗ | Studio-scoped; planned (A4) — no main-site UI |
| Publish / schedule a version | ✗ | ✓ | Studio deferred (Q2); lives on the model-version page |

### Insight (see what you earn)

| Capability | Creator Studio | Main site | Notes |
|---|---|---|---|
| Per-model earnings by source | ✓ | ~ | Studio planned (A1); main shows Buzz totals, not per-model-by-source |
| Usage & content analytics | ✓ | ~ | Studio planned (A1/C1); scattered across main today |
| CP cash status (pending / settled) | ✓ | ✓ | Studio displays + links out; canonical view is the Buzz dashboard |
| Creator score + requirements | ✓ | ✓ | Both display; Studio shows it on `/join` with growth tips |

### The cash-out pipeline & account (program mechanics)

| Capability | Creator Studio | Main site | Notes |
|---|---|---|---|
| **Bank Buzz** into the Compensation Pool | ✗ | ✓ | Program action — Buzz dashboard only |
| **Withdraw cash** (Extraction Phase, payment partner) | ✗ | ✓ | Studio link-out only |
| Banking cap / tier scaling | ✗ | ✓ | Membership + program mechanic |
| Enroll in / join the Creator Program | ✗ | ✓ | Studio `/join` = upsell + link-out to `/creator-program` |
| Buy / upgrade membership | ✗ | ✓ | Links out to `/pricing` |
| Payout (Tipalti) setup | ✗ | ✓ | Studio `/settings` shows status only |

Legend: ✓ = offered · ✗ = not offered · ~ = partial. The **Creator Studio** column reflects *scope* — see Notes
for built vs planned. The pattern is clear: the Studio owns the **controls + insight**, the main site owns the
**cash-out pipeline + account**, and the Studio **links out** rather than rebuilding banking/withdrawal/billing.

---

## What the Creator Program page advertises (member perks)

| CP perk | What it is | Owned by |
|---|---|---|
| **Turn Buzz into real earnings** | The headline — convert earned Buzz to cash | Program (main app) |
| **Bank your Buzz** | Bank Yellow/Green Buzz into the monthly Compensation Pool | Buzz dashboard (main app) |
| **Claim your share / withdraw cash** | Withdraw during the 3-day Extraction Phase via the payment partner (Tipalti) | Buzz dashboard (main app) |
| **Bankable Buzz sources** | Early Access, Tips, Generator Compensation can all be banked | Program mechanic (main app) |
| **Tier-scaled banking cap** | Higher membership tiers (Silver/Gold) raise the monthly bank cap | Membership + program (main app) |
| **Requirements** | Active Civitai membership **+** creator score ≥ 40,000 | Gate (shared) |

## What the Creator Studio is scoped to offer

Per [implementation-checklist.md](implementation-checklist.md) / the page specs:

| Studio capability | Page | Status |
|---|---|---|
| Set / adjust / clear **per-image licensing fees** (single + bulk) | `/models` | ✅ built |
| Edit **early / paid access** config (duration, download/gen price, trials, donation goal) | `/models` | ✅ built |
| **Sell access indefinitely** | `/models` | 🚧 A4 (backend) |
| Publish / schedule a version | `/models` | ⏭ open (Q2) |
| **Earnings by source** (comp / license / tips / access / cosmetic) | `/earnings` | 🚧 A1/A5 |
| **Usage & earnings analytics** (generations, downloads, reactions, followers…) | `/earnings/analytics` | 🚧 A1/C1 |
| **CP cash status** (pending / settled) + **Withdraw link-out** | `/earnings`, dashboard | 🚧 A1 |
| **Payout (Tipalti) status** + membership/tier status | `/settings` | ◻ not started |
| **Creator Program upsell** + live creator score + how-to-grow | `/join` | ✅ built |

---

## Side-by-side: is each CP perk covered by the Studio?

| Creator Program perk | In the Studio? | Where / notes |
|---|---|---|
| Turn Buzz into real earnings | **Indirectly** | Studio provides the *levers* that generate Buzz (fees, early access) and *shows* earnings; the earn→cash conversion is the program's, not the Studio's. |
| Bank your Buzz | **No (by design)** | Banking is a Buzz-dashboard action; Studio links out. |
| Withdraw cash (Extraction Phase) | **Link-out only** | `/earnings` shows CP cash status + a **Withdraw** link-out; the actual withdrawal is main-app. |
| Bankable sources (Early Access, Tips, Gen Comp) | **Partial** | Studio *controls* Early Access and *displays* these as earnings sources; it doesn't bank them. |
| Tier-scaled banking cap | **No** | Membership/tier concern; Studio only shows tier **status** (`/settings`). |
| Requirements (membership + score ≥ 40k) | **Yes** | `/join` shows the gate, the user's live creator score, and how to grow it. |

## Things the Studio offers that the CP page does *not*

The Studio isn't a subset — it adds creator-facing **control + insight** the CP marketing page doesn't cover:

- **Per-version licensing-fee control** (fractional, single + **bulk** editing, apply-default-by-type).
- **Full early/paid-access config editing** from one surface (the CP page only *mentions* Early Access as a
  bankable source; it doesn't let you configure it).
- **Sell access indefinitely** (once A4 lands) — a Studio/monetization capability, not a CP-page concept.
- **Per-model earnings + usage analytics** (what each model earns and the usage driving it).
- **Payout / membership status** in one place (`/settings`).

## The boundary (who owns what)

- **Studio owns:** the monetization *controls* (fees, access), *insight* (earnings, analytics), and *status*
  (CP cash, payout, membership) — plus the acquisition funnel (`/join`).
- **Main app owns:** the *program mechanics* — banking, the Compensation Pool, the Extraction Phase, withdrawal
  via the payment partner, banking caps, and membership purchase/upgrade.
- **Handoff:** `/join` → `civitai.com/creator-program` and `civitai.com/pricing`; `/earnings` & `/settings` →
  Buzz dashboard for banking/withdrawal. The Studio never rebuilds billing, banking, or withdrawal.

## Implication for `/join` copy

The `/join` perk cards now lead with **"Earn real cash"** (bank Buzz → withdraw monthly) so the page conveys the
CP's headline payoff, then the Studio-specific levers (fees, sell-indefinitely, analytics). The
**"What membership unlocks"** capability table stays **Studio-scoped** (Everyone vs CP member) — cash withdrawal
is deliberately *not* a row there, since it isn't a Studio control.
