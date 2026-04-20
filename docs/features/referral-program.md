# Referral Program - Design

## Overview

A spend-triggered referral program where every user has a shareable code. When someone redeems that code and **spends money** on Civitai, both parties earn rewards:

- **Referrer** earns **Referral Tokens** (redeemable for temporary membership perks) on each qualifying membership payment from their referees, plus **Blue Buzz kickbacks** on referee buzz purchases.
- **Referee** gets a one-time discount/bonus on their first paid event.

Unlike the legacy signup-only referral system, rewards are tied to actual revenue events, not account creation.

### Goals

1. Drive paid membership conversions through peer advocacy.
2. Give community an organic way to earn premium perks without gating access behind cash.
3. Incentivize NSFW-generation-enabled audience to recruit, via Blue Buzz + membership perk bundle.
4. Reuse existing infrastructure (`UserReferralCode`, redeemable code service, signal service) to minimize build cost.

### Non-Goals (v1)

- Multi-tier / MLM-style cascading rewards (keeps us out of FTC pyramid-scheme territory).
- Cash payouts to referrers (rewards stay in-platform: tokens, blue buzz).
- Cross-domain referrals (`.com` only for v1).
- Automated fraud prevention beyond logging for later review.

## Mechanics Summary

```
Referee flow:
  Visit link with ?ref_code=XYZ → cookie stored (5 days)
  Sign up (binds UserReferral row)
  Make first paid membership charge
    → Referee receives: 25% of tier's monthlyBuzz as Blue Buzz (one-time)
    → Referrer receives: 1-3 Referral Tokens (pending settlement)
  Each subsequent membership renewal (up to month 3)
    → Referrer receives: +1 token per paid month (tier-based: Bronze=1, Silver=2, Gold=3)
  Each buzz purchase by referee
    → Referrer receives: 10% of purchase amount as Blue Buzz (pending settlement)

Settlement:
  7 days after event, reward moves from pending → settled
  Settled tokens can be spent in the Referral Shop
  Settled blue buzz is credited to referrer's blue buzz account

Token redemption:
  Referrer visits Referral Shop
  Spends tokens on membership-time bundles (tier × duration)
  Creates a CustomerSubscription with monthlyBuzz=0 (perks only, no buzz stipend)
  Tokens expire 90 days after earn
```

## Token Economy

### Earning

| Referee Event | Tokens Earned |
|---|---|
| Bronze membership month paid | 1 |
| Silver membership month paid | 2 |
| Gold membership month paid | 3 |
| Cap per referee | 3 paid months total |

**@ai:*** Is the cap `3 paid months per referee` or `max 3 tokens per referee regardless of tier`? Current proposal is the former, meaning a referee on Gold pays out `3 + 3 + 3 = 9 tokens`. Confirm.

### Redemption Shop

| Cost | Grant |
|---|---|
| 1 token | 2 weeks Bronze perks |
| 2 tokens | 1 month Bronze perks |
| 3 tokens | 2 weeks Silver perks |
| 4 tokens | 1 month Silver perks |
| 5 tokens | 2 weeks Gold perks |
| 6 tokens | 1 month Gold perks |

Redemption creates a `CustomerSubscription` with `monthlyBuzz = 0` (no buzz stipend, perks only) and `currentPeriodEnd = now + duration`. Uses existing `redeemableCode.service.ts` patterns.

### Expiry

Tokens expire **90 days from earn**. Nightly cron deletes expired tokens, fires `referral:token-expiring-soon` signal at T-7 days.

### Interaction With Paid Subs

If redeemer already holds a paid subscription:

- **Redeemed tier > paid tier**: Stack as separate `CustomerSubscription` row. Effective tier = `max(paidTier, referralTier)`. Session user picks highest.
- **Redeemed tier ≤ paid tier**: Still allowed but no effective benefit during paid period. Referral sub's `currentPeriodEnd` continues ticking (not paused). User wastes tokens if they redeem while actively subscribed at a higher tier.

UI warns user if they're about to redeem a lower-or-equal tier than their active paid sub.

### Badges & Buzz Stipend

Referral-granted subscriptions **do not** grant:
- Tier-specific badges (displayed badge stays on paid sub only)
- Monthly buzz stipend (Product has `monthlyBuzz = 0`)
- Eligibility for Creator Program bank multipliers tied to paid tier (@ai:* confirm)

They **do** grant: all feature-flag-gated perks (NSFW gen via blue buzz, private models, priority generation, assistant personality, etc.).

## Blue Buzz Kickback

### Rate

**10% of buzz purchase amount → Blue Buzz to referrer.**

Assumes $1 = 1k buzz exchange. Example: referee buys $50 buzz pack (50k yellow) → referrer earns 5k blue buzz.

Only applies to buzz purchases (yellow). Does NOT apply to:
- Membership payments (those pay out in tokens only)
- Tip income, creator earnings, or other non-purchase buzz movements

### Milestone Bonuses

Lifetime Blue Buzz earned via kickback triggers one-time bonus payouts:

| Lifetime earned | Bonus |
|---|---|
| 1,000 | +500 |
| 10,000 | +2,500 |
| 50,000 | +15,000 |
| 200,000 | +50,000 |
| 1,000,000 | +250,000 + "Top Affiliate" cosmetic badge |

Milestones are permanent one-shots — each user hits each milestone at most once (lifetime). Earned counter does not reset.

**@ai:*** First milestone calibrated so a single $10 buzz purchase by a referee hits it — gives instant dopamine. Tune if needed.

## Data Model

### New Tables

```prisma
model ReferralToken {
  id              Int       @id @default(autoincrement())
  userId          Int       // referrer
  sourceEventId   String    // "stripe_invoice_<id>" or similar
  amount          Int       // count (1 per monthly payment; can batch if tier=2,3)
  status          ReferralTokenStatus  // pending | settled | redeemed | expired | revoked
  earnedAt        DateTime  @default(now())
  settledAt       DateTime?
  expiresAt       DateTime  // earnedAt + 90 days
  redeemedAt      DateTime?
  user            User      @relation(fields: [userId], references: [id])

  @@index([userId, status])
  @@index([expiresAt])
}

enum ReferralTokenStatus {
  pending    // within 7-day settlement window
  settled    // available to spend
  redeemed   // spent in shop
  expired    // 90 days passed without spend
  revoked    // chargeback / fraud clawback
}

model ReferralBlueBuzzEarning {
  id            Int       @id @default(autoincrement())
  userId        Int       // referrer
  sourceEventId String    // "buzz_purchase_<id>"
  refereeId     Int       // who made the purchase
  purchaseAmount Int      // yellow buzz purchased
  kickbackAmount Int      // 10% in blue buzz
  status        ReferralTokenStatus  // reuses enum: pending | settled | revoked
  earnedAt      DateTime  @default(now())
  settledAt     DateTime?

  @@index([userId, status])
  @@index([refereeId])
}

model ReferralMilestone {
  id          Int       @id @default(autoincrement())
  userId      Int
  threshold   Int       // e.g. 1000, 10000
  bonusAmount Int       // blue buzz granted
  awardedAt   DateTime  @default(now())

  @@unique([userId, threshold])
}
```

### Extensions to Existing

- `UserReferral`: add `firstPaidAt DateTime?` (first qualifying membership payment — prevents double-rewarding on first charge)
- `UserReferralCode`: no changes needed (code string + userId already sufficient)

### Cookie Persistence Change

Current cookie = 5 days (`ReferralsProvider.tsx:48`). **Bump to 30 days** for v1. Reason: 5 days is too short for the "click now, buy later" flow. 30 days is industry standard.

**@ai:*** Confirm bumping cookie TTL to 30 days is OK. Also check if existing user `createUserReferral()` logic at `user.service.ts:1688-1693` still works correctly with a 30-day window.

## Signal Events

All sent via `signalClient.send({ userId, target, data })` from `src/utils/signal-client.ts`.

Add to `SignalMessages` enum in `src/server/services/signals.service.ts:122`:

| Signal | Target | Payload | When |
|---|---|---|---|
| `referral:click` | `ReferralClick` | `{ count, last24h }` | Aggregated daily digest of link clicks |
| `referral:checkout-viewed` | `ReferralCheckoutViewed` | `{ anonymous: true }` | Someone with referrer's code on checkout page. Rate limit: 1 per 5 min per referrer |
| `referral:purchase-pending` | `ReferralPurchasePending` | `{ type: 'membership' \| 'buzz', tokens?: number, blueBuzz?: number, settlesAt: Date }` | Purchase succeeded, reward pending |
| `referral:settled` | `ReferralSettled` | `{ type, tokens?, blueBuzz? }` | 7 days passed, reward now spendable |
| `referral:milestone` | `ReferralMilestone` | `{ threshold, bonusAmount }` | Lifetime Blue Buzz crossed threshold |
| `referral:tier-granted` | `ReferralTierGranted` | `{ tier, durationDays }` | Successfully redeemed tokens |
| `referral:clawback` | `ReferralClawback` | `{ reason, tokens?, blueBuzz? }` | Chargeback / fraud detected |
| `referral:token-expiring-soon` | `ReferralTokenExpiring` | `{ count, expiresAt }` | 7 days before token batch expires |

Client hook: `useSignalConnection(SignalMessages.ReferralSettled, onSettled)` in new `src/components/Referrals/ReferralSignals.ts`.

## Settlement State Machine

```
event fires → PENDING (settlement timer starts, 7 days)
                 │
                 ├─ 7 days elapsed, no chargeback → SETTLED
                 │                                       │
                 │                                       ├─ user redeems tokens → REDEEMED
                 │                                       └─ 90 days elapsed, unredeemed → EXPIRED (tokens only)
                 │
                 └─ chargeback within 7 days → REVOKED (reward never credited)
                 └─ chargeback AFTER 7 days  → REVOKED + deduct from future (or negative balance)
```

### Chargeback Handling

- **Within 7 days**: clean revoke — reward never hit referrer's balance.
- **After 7 days**: referrer may have already spent. Strategies, cheapest first:
  1. Deduct from referrer's pending/settled token balance first.
  2. If insufficient, deduct from future earnings (debt queue).
  3. If referrer has no future activity, write off (marketing cost).
- **Revoked CustomerSubscription**: if referrer already redeemed tokens for tier time and chargeback clawback empties their balance below zero, do we claw back the active tier grant? **@ai:*** I recommend NO (too hostile) — just prevent further redemptions until debt cleared.

## Fraud Detection (Logging Only, v1)

Per Justin's direction: no active prevention in v1. Log signals for later review.

Log per reward event:

- Referrer + referee `userId`, `createdAt`, `emailDomain`
- Device fingerprint match (same device = flag)
- IP match / CIDR overlap
- Payment method fingerprint (Stripe `PaymentMethod.fingerprint`)
- Referee sub duration before first payout (< 3 months = flag)
- Time between signup and first purchase (< 1 hour = flag)
- Referrer's historical referral reward-to-revenue ratio (outlier = flag)

All logged to ClickHouse `referralAttribution` table. Mod dashboard lists top flagged referrers for manual review.

## UI Surfaces

### Referral Dashboard (`/user/referrals`)

**Hero section**:
- Your referral code (big, copy button)
- Share buttons (Twitter, Reddit, Discord, copy link)
- Live counter: "Someone is viewing checkout with your code right now" (when applicable)

**Stats cards**:
- Total clicks (last 30 days)
- Successful conversions (unique referees who paid)
- Lifetime Blue Buzz earned
- Next milestone progress bar

**Tokens panel**:
- Settled token balance (spendable)
- Pending tokens (+ settlement ETA)
- Expiring soon warning (tokens within 7 days of expiry)
- "Redeem" CTA → opens shop modal

**Shop modal**:
- Grid of tier × duration options with costs
- Confirm → creates referral sub

**Activity feed** (anonymized):
- "A referee just subscribed to Silver — 2 tokens pending"
- "A referee bought 10k buzz — 1k blue buzz pending"
- "Milestone hit: 10k lifetime — +2.5k bonus"

**No referee identities shown.** Aggregate only.

### Onboarding / Signup

- Already captures `ref_code` via `OnboardingBuzz.tsx`. Keep as-is.
- Add post-first-paid-event toast: "You used a referral code — enjoy your bonus!"

### Checkout Flow

- **Code entry**: manual input field on checkout page. If `ref_code` cookie is set, pre-fill and lock (user can clear/replace). If no cookie, field is empty and optional.
- **Banner when code valid**: show the referee bonus they'll earn.
  - Copy: `"Using code XYZ. You'll receive 2,500 Blue Buzz on completion — enough for ~250 generations."`
  - Bonus amount computed from `selectedTier.monthlyBuzz * 0.25`
  - Generation count computed from an average cost-per-gen constant (pulled from existing config, same constant the gen page uses)
  - **No mention of mature/NSFW content in copy.** Keep it generic.
- Emit `referral:checkout-viewed` signal to referrer when banner renders (rate-limited).
- **Stripe audit required**: verify existing Stripe/Paddle checkout flow supports passing `ref_code` through to completion webhook. Prior to implementation, scout `src/server/services/stripe.service.ts` and checkout modal to find the injection point. @ai:* Action item for Phase 1.

### User Nav

- Add "Referrals" entry under user menu.
- Badge on icon if unspent settled tokens exist.

## Program Terms

Separate page: `/referrals/terms`. Linked from main TOS with single-line reference.

Cover:

- **Eligibility**: Civitai account in good standing. Minimum account age 7 days to earn (keeps brand-new alts out).
- **Earning rules**: Tokens on referee paid membership months (first 3). Blue Buzz 10% on referee yellow buzz purchases. Settlement in 7 days.
- **Non-transferability**: Tokens and Blue Buzz are non-transferable, non-refundable, no cash value.
- **Expiry**: Tokens expire 90 days from earn. Unused = forfeit.
- **Prohibited**: Automated fraud, incentivized clicks from paid ad networks without disclosure, use of code by banned/suspended accounts.
- **Enforcement**: Civitai may claw back rewards, terminate participation, or ban for program abuse at sole discretion.
- **Modifications**: Civitai may modify or terminate program with 30 days notice.

**@ai:*** Legal review needed on terms before launch. Especially the "self-referral via alt" acceptance — unusual stance, worth a sentence in terms ("multiple accounts per household OK, but bot-driven mass self-referral is not").

## Rollout Plan

### Feature Flag

Wrap in Flipt flag `referral-program-v2` scoped by user. Rollout phases:

1. **Internal**: Civitai team only (5-10 users). Dogfood for 1 week.
2. **Alpha**: Opt-in waitlist for heavy creators. 100 users. 2 weeks.
3. **Beta**: 10% of paying-user base. 2 weeks. Monitor fraud metrics.
4. **GA**: All users.

Kill switch: flag off = no new earnings, existing balances preserved, shop disabled.

### Migration

No data migration. Legacy `UserReferral` rows stay intact (signup-only rewards already disabled in code; just leave commented).

### Monitoring

- Grafana dashboard: tokens earned/redeemed per day, Blue Buzz kickback per day, top 20 referrers, fraud-flag rate
- Axiom log stream: all `referral:*` signal events
- ClickHouse: `referralAttribution` table for fraud analysis queries

### Success Metrics

- % of paid memberships attributed to referrals (v1 target: 5%)
- Conversion rate from click → referee signup → paid membership
- Blue Buzz kickback pool as % of yellow buzz revenue (cost-of-program metric)
- Churn delta on referee vs non-referee cohorts

## Implementation Phases

### Phase 1: Core earning + settlement (backend)
- DB migrations
- `ReferralToken`, `ReferralBlueBuzzEarning`, `ReferralMilestone` tables
- Stripe/Paddle webhook hooks
- Settlement cron (7 days)
- Clawback logic
- Signal emission

### Phase 2: Shop + redemption
- Shop tRPC router
- Reuse `redeemableCode.service.ts` for tier grant
- Redemption UI modal

### Phase 3: Dashboard + signals
- `/user/referrals` page
- Client signal hooks
- Click-tracking + anonymized activity feed
- User nav integration

### Phase 4: Checkout attribution
- Persist `ref_code` cookie to 30 days
- Checkout banner
- `referral:checkout-viewed` signal wiring

### Phase 5: Fraud logging + ops
- ClickHouse `referralAttribution` schema
- Mod dashboard
- Runbook for manual review

### Phase 6: Program terms + marketing
- Terms page
- Email / in-app promo
- Discord announcement

## Open Questions

1. **@ai:** Cap semantics: 3 paid months per referee cap, or 3 tokens max per referee? (Affects Gold payout: 9 tokens vs 3) @justin: Okay, so regarding caps. I think it's three paid months per referee. If you're getting people to get gold, then yeah, it's higher than three tokens. @ai: Locked. 3 paid months per referee → Gold payout can be up to 9 tokens.
2. **@ai:** Cookie TTL bump from 5 → 30 days — any downstream assumption of 5-day window we'd break? @justin: 30 days good. @ai: Locked. Will bump `ReferralsProvider.tsx:48`.
3. **@ai:** Creator Program multiplier interaction: does referral-granted tier affect buzz banking multipliers? If yes, must explicitly exclude. @justin: Yeah, I think they can get all membership perks... except the monthly Buzz. @ai: Locked. Referral sub grants: Creator Program multiplier YES, NSFW blue buzz YES, private models YES, priority gen YES. Excludes: monthly buzz stipend (`monthlyBuzz=0`) and tier-specific badge.
4. **@ai:** Clawback aggression: if referrer has active redeemed tier and balance goes negative from chargeback, do we revoke the tier grant? Recommend no. @justin: no. But we should have a settlement period, so if they refund or chargeback before settlement we take their token. Might be hard to track... Probably can wait for a future iteration. @ai: Locked. V1 policy = chargeback within 7-day settlement window → revoke pending token/buzz (clean, already handled by state machine). Post-settlement chargebacks = write off in v1. No debt-queue for v1.
5. **@ai:** Legal review on program terms, especially multi-account / household policy. @justin: Do we really need this? @ai: Probably not for v1. Civitai's existing TOS covers most of this. I'll self-write boilerplate program terms (non-transferability, expiry, anti-abuse clause). Formal legal review can wait until we see real volume or expand to new jurisdictions. OK to proceed without lawyer pass? @justin: Yeah, let's go ahead and self write terms. @ai: Locked. Sub-agent drafting `docs/features/referral-program-terms.md` now.
6. **@ai:** Blue Buzz kickback rate: 5% (conservative) vs 10% (recommended). Milestone math above assumes 10%. @justin: Let's do 10%. @ai: Locked at 10%.
7. **@ai:** Should we allow users to generate multiple codes (current cap: 3) or collapse to a single code per user for simpler mental model? @justin: Single code per user. From time to time we might add a custom code to a user, but that'd be for special users with a social media following for example. @ai: Locked. Single auto-generated code per user + admin-created custom codes for special users. Will drop `referralCodeMaxCount` to 1 for self-gen. Custom codes = same `UserReferralCode` table, admin-only creation path (mod-actions skill or direct DB in v1 — no self-serve admin UI).

## New Questions From Justin's Replies

8. **@ai:** Referee bonus: my doc said "one-time discount OR bonus buzz" on first paid event but that's fuzzy. Concrete proposals:
   - Option A: 10% off first membership month (Stripe coupon on first invoice)
   - Option B: Nothing for referee — referrer earns, referee just helped a friend. Simplest to build.
   - Option C: Small blue buzz bonus (e.g. 500 blue buzz) on first paid event
   Which do you want? My vote: **B for launch** (simplest), add C later if conversion data is weak. @justin: I think C is appropriate. @ai: Locked at **C: 1,000 Blue Buzz to referee on first paid membership**. (Amount TBD if you want different — 500-2,500 range makes sense. Proposing 1,000.)

9. **@ai:** Post-settlement chargeback tracking: you said "might be hard to track... future iteration." Confirming v1 = **write off, no debt-queue**. We'll log the loss to fraud-detection table so top abusers surface in mod review, but referrer doesn't owe anything back. OK? @justin: Right off. No one owed. @ai: Locked. Write-off, fraud table logs for review, no user-facing debt.

10. **@ai:** Custom codes admin UX: for v1, manual DB insert (or mod-actions script) is fine? Or do you want a simple admin form in the moderation dashboard? Recommend v1 = DB/script, v2 = admin form. @justin: DB is fine for custom codes in v1. It'd still be a single code per user I think. @ai: Locked. One code slot per user. Admin DB update overwrites the auto-generated code string (e.g. "X3K7P9" → "JUSTINM"). `referralCodeMaxCount` drops to 1. No separate custom-code table.

11. **@ai:** Referee bonus amount: 1,000 Blue Buzz feels right (matches 10% of a $10 membership at $1=1k). Sound OK, or want higher/lower? @justin: Let's make the bonus be 10% extra Buzz for the month granted as Blue Buzz (for example, 1k Blue Buzz if you got the Bronze Membership which grants 10k Buzz). @ai: Locked. Bonus = `Product.metadata.monthlyBuzz * 0.10` as Blue Buzz. Scales with tier — Bronze 10k buzz → 1k blue, Silver/Gold proportionally higher. Only on first paid membership (not renewals). @justin: What if it was like a bigger portion, like maybe 25% or even 20%? @ai: Final: **25%** of tier's monthlyBuzz as Blue Buzz, displayed at checkout (not post-pay). Tiers $10/$25/$50 → Bronze 2.5k, Silver 6.25k, Gold 12.5k blue buzz. Zero cash cost to us (compute). Surfacing at checkout makes this a conversion lever, not just a reward.

12. **@ai:** Checkout manual code entry: adding an input field to checkout (pre-filled from cookie if present, manually enterable if not). This requires auditing the existing Stripe/Paddle checkout flow — will scout `src/server/services/stripe.service.ts` and related checkout components in Phase 1 prep to find the correct injection point. @ai: Implemented via `ReferralCheckoutBanner` on `/pricing`. Stripe checkout session now carries `ref_code` via `subscription_data.metadata` → reconciled on `invoice.paid` webhook.

## Overlap Stacking Approach (v1)

`CustomerSubscription` has `@@unique([userId, buzzType])`. Paid subs use `yellow` (.com), `green` (.green), `blue` (.red). Using any of those for referral grants collides with paid subs of the same flavor.

**V1 solution**: Referral grants write `CustomerSubscription.buzzType = 'referral'`. The column is `String` (not enum), session-user iterates all sub rows and picks the highest tier across buzz types via `constants.memberships.tierOrder`. Result: a user can hold paid yellow + paid green + referral Gold simultaneously, and feature flags / perk checks see Gold.

Behavior when a user redeems while they already have an active referral sub:
- **Same or lower tier**: extends `currentPeriodEnd` by `durationDays` starting from the existing end date
- **Higher tier**: swaps `productId` to the new tier, restarts `currentPeriodStart` at `now`, sets `currentPeriodEnd = now + durationDays`

Behavior when an existing referral sub is expired or inactive: reactivate with new tier.

**V1 does not** pause or offset the referral grant against a concurrent paid sub. If a paid Gold user redeems a Gold referral, they "double up" and the referral clock ticks during the paid period. User has agency to time the redemption.

**V2 follow-ups** (not blocking launch):
- Add `activatesAt` field or metadata flag so referral grants can queue to activate after a paid sub expires
- Dashboard UI warning when the redemption tier is less-or-equal to the user's active paid tier
- Support multiple queued referral grants (stack in metadata, advance on each expiry)

## Attribution + Fraud Detection

`ReferralAttribution` Postgres table logs every attribution-relevant event:
- `membership_payment`, `membership_payment_over_cap`
- `buzz_kickback`, `buzz_kickback_skipped_no_membership`
- `referrer_too_young`

Each row captures `referralCodeId` (FK to `UserReferralCode`), `refereeId`, event type, source event id (Stripe invoice or PI), payment provider, Stripe PI / invoice / charge IDs, card fingerprint (from Stripe `PaymentIntent.payment_method.card.fingerprint`), IP address (when available), and a JSON metadata blob.

**Indexes**: `(referralCodeId, createdAt)`, `(refereeId)`, `(paymentMethodFingerprint)`, `(ipAddress)`, `(stripePaymentIntentId)` — optimized for the "show me everything tied to this code / card / IP" queries.

Use postgres-query skill for ad-hoc mod review. Paddle events are not attributed (Paddle is deprecated; see paddle.ts header comment).

## Notifications

Referral reward events fire both **signals** (live UI updates) and **Notifications** (persistent in-app + email when subscribed):

| Event | Signal | Notification |
|---|---|---|
| Pending purchase | `referral:purchase-pending` | — |
| Reward settled (referrer) | `referral:settled` | `referral-reward-settled` |
| Welcome bonus settled (referee) | — | `referral-welcome-bonus` |
| Milestone hit | `referral:milestone` | `referral-milestone-hit` |
| Tokens expiring in 7d | `referral:token-expiring-soon` | `referral-token-expiring` (daily cron, deduped per-user-per-expiry-date) |
| Tier granted via redemption | `referral:tier-granted` | — |
| Click / checkout-viewed | `referral:click`, `referral:checkout-viewed` | — |
| Chargeback clawback | `referral:clawback` | — |

Types live in `src/server/notifications/referral.notifications.ts` and are registered in `utils.notifications.ts`.


