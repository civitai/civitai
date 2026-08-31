# Gift Memberships (GREEN / Stripe) — Implementation Plan

**Status**: Implemented (phases 1–6) — pending review + QA. Migration `20260729200000_membership_gifts` must be applied manually.
**Branch**: `worktree-gift-memberships`

## Summary

Let a user pre-pay N months of a GREEN (Stripe) membership as a gift for another user.

- Gifter pays **once** via Stripe Checkout (`mode: 'payment'`) — no subscription is created for the gifter.
- If the recipient **has an active green subscription** → their Stripe subscription gets N months free (they keep auto-renewing afterward at their normal price).
- If the recipient **has no green subscription** → we create a Stripe subscription for them server-side that costs $0 for N months and auto-cancels at the end (they can attach a payment method to keep it going).

This is deliberately **Stripe-native and independent of the redeemable-code system**. The code/prepaid-token machinery (`redeemableCode.service.ts`, `prepaid-membership-jobs.ts`) is built for `PaymentProvider.Civitai` / yellow-buzz memberships and is incompatible with green subs: `upsertSubscription` (`stripe.service.ts:581`) overwrites `CustomerSubscription.metadata` with Stripe's subscription metadata on every webhook, so any prepaid state stored there would be clobbered. All gift state therefore lives in Stripe (coupons/subscription fields) plus a small audit table on our side.

## Why this design works with existing plumbing

Verified against current code:

- **`invoice.paid` grants monthly Buzz even for $0 invoices** (`stripe.service.ts:813` `manageInvoicePaid`): the Buzz grant only requires an invoice line for a membership product with `billing_reason` in `subscription_create|cycle|update` — it does not check `amount_paid`. A 100%-off coupon still produces a monthly `invoice.paid` at $0, so **monthly Buzz keeps flowing to gifted members with zero new code**.
- **`customer.subscription.created/updated/deleted` webhooks** (`webhooks/stripe.ts:121`, `upsertSubscription`) already create/update the `CustomerSubscription` row, set vault storage, sync Freshdesk, and invalidate session/multiplier caches. A server-created gift subscription rides this path untouched.
- **Attribution / referral safety**: App Blocks subscription attribution is already gated on `amount_paid > 0` (`stripe.service.ts:992`), so $0 gift invoices don't accrue publisher shares.

## Mechanism

### The gift coupon

For each fulfillment we create a **single-use Stripe coupon**: `percent_off: 100`, `duration: 'repeating'`, `duration_in_months: N`, `max_redemptions: 1`, metadata `{ giftId }`. (One coupon per gift, not shared — auditable and revocable.)

### Case A — recipient has an active green subscription (monthly interval)

Apply the coupon to their existing subscription (`stripe.subscriptions.update(subId, { discounts: [{ coupon }] })`):

- Their next N monthly invoices are $0; billing dates don't move; after N months Stripe resumes charging automatically. Economically identical to "extended by N months for free".
- `invoice.paid` keeps firing monthly → Buzz keeps flowing; `customer.subscription.updated` keeps `currentPeriodEnd` in sync.
- **Canceled-but-active subs** (`cancel_at_period_end: true`, remaining time left): the coupon alone would do nothing — the sub never generates another invoice, so the gift would silently evaporate. But plain un-canceling is wrong too: the user deliberately canceled, and reinstating them means Stripe resumes charging after the gift ends, without their consent. Instead we **defer the cancellation**: in the same `subscriptions.update` call, apply the coupon and replace `cancel_at_period_end: true` with `cancel_at = current_period_end + N months`. Their remaining paid time plays out, the next N renewals invoice at $0 (all fall inside the coupon window since remaining time ≤ 1 billing month), then the sub cancels — they're never billed again unless they explicitly reinstate (`reinstateSubscription` clears `cancel_at`). `upsertSubscription` already syncs `cancel_at` from the `customer.subscription.updated` webhook, so the membership page shows the pushed-out end date for free.
  - Boundary edge: if the gift lands at the exact instant of a renewal, the Nth free invoice sits right on the coupon window boundary (rare off-by-one risk → N−1 free months). Mitigation: after applying, verify with `invoices.retrieveUpcoming` and log/alert on mismatch rather than over-engineering the window.

### Case B — recipient has no green subscription (none, or canceled/incomplete)

Create the subscription for them, server-side:

```ts
stripe.subscriptions.create({
  customer,                             // createCustomer() if they've never had one
  items: [{ price: monthlyPriceForTier }],
  discounts: [{ coupon: giftCoupon }],  // 100% off for N months
  cancel_at: now + N months,            // hard stop — never bills the recipient
  metadata: { giftId, gift: 'true' },
});
```

- Every invoice during the gift window is $0, so **no payment method is required**.
- The existing webhook path creates the `CustomerSubscription` (buzzType `green` from product metadata), sets vault size, invalidates caches. Monthly Buzz flows via `invoice.paid`.
- At `cancel_at`, Stripe cancels → `customer.subscription.deleted` webhook cleans up (row deleted, vault reset) exactly like any other cancellation.
- **Conversion hook**: recipient can "keep my membership" by adding a payment method and removing `cancel_at` (the existing `reinstateSubscription` flow at `stripe.service.ts:1178` is close; small extension to also require a default payment method).

### Edge cases in fulfillment

| Recipient state                                    | Behavior                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active green sub, **same tier** as gifted, monthly | Case A                                                                                                                                                                                                  |
| Active green sub, **`cancel_at_period_end: true`** | Case A + deferred cancellation: coupon applied and `cancel_at` pushed to `current_period_end + N months` — free months happen, then the sub still ends; no billing resumes without explicit reinstate   |
| Active green sub, **different tier**               | See open question #1                                                                                                                                                                                    |
| Active green sub, **annual interval**              | A repeating-months coupon would zero an entire annual invoice (over-gifting). See open question #2                                                                                                      |
| Green sub `past_due` / `paused` / `incomplete`     | Treat as Case B is unsafe (customer may have a broken sub). v1: apply coupon (Case A) if status is `active` or `trialing`; otherwise credit as in open question #2, or fail with support-visible status |
| Has **yellow (Civitai) membership** only           | Green and yellow rows coexist (`userId_buzzType` unique). Gift proceeds as Case B; entitlements already resolve via highest tier (`getHighestTierSubscription`)                                         |
| Recipient is a banned/deleted user                 | Block at purchase time                                                                                                                                                                                  |

## Data model

New table for audit + idempotent fulfillment (migration in `packages/civitai-db-schema/prisma/migrations/` — **applied manually per environment, per repo policy**):

```prisma
model MembershipGift {
  id           String    @id @default(cuid())
  gifterId     Int
  recipientId  Int
  tier         String    // bronze | silver | gold
  months       Int
  amountCents  Int       // what the gifter paid
  status       String    @default("pending") // pending | fulfilled | failed | refunded | revoked
  message      String?   // optional gift note shown to recipient
  anonymous    Boolean   @default(false)

  stripeCheckoutSessionId String?  @unique
  stripePaymentIntentId   String?  @unique
  stripeCouponId          String?
  stripeSubscriptionId    String?  // sub the gift was applied to / created

  fulfilledAt  DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  gifter    User @relation("giftsGiven", fields: [gifterId], references: [id])
  recipient User @relation("giftsReceived", fields: [recipientId], references: [id])

  @@index([recipientId])
  @@index([gifterId])
}
```

`status` transitions: `pending` (row created at checkout start) → `fulfilled` (webhook applied it) / `failed` (fulfillment threw; support follow-up) → `refunded`/`revoked` (chargeback/refund handling).

## Purchase flow

1. **UI** (modal, see below): gifter picks recipient (user search), tier, months (1 / 3 / 6), optional message + anonymous toggle. Price = flat months × the tier's monthly Stripe price (no bundle discount — decided).
2. **tRPC** `membershipGift.createCheckoutSession` (protected):
   - Validate recipient (exists, not banned, not self? — open question #5, recipient's sub state to pick Case A/B messaging).
   - Create `MembershipGift` row (`pending`).
   - Create Stripe Checkout session `mode: 'payment'` on the **gifter's** customer (`createCustomer` if needed), `line_items` via `price_data` (months × tier monthly unit amount, product = tier product so it reads nicely on receipts), `metadata: { type: 'membershipGift', giftId }` on both session and payment intent.
   - Return redirect URL.
3. **Webhook fulfillment** — in `webhooks/stripe.ts` `checkout.session.completed` (`mode === 'payment'` branch, before `manageCheckoutPayment`): if `session.metadata.type === 'membershipGift'` → `fulfillMembershipGift(giftId, paymentIntentId)` in a new `membership-gift.service.ts`:
   - Load gift row; **idempotency**: bail if not `pending` (Stripe retries webhooks).
   - Re-check recipient's green subscription → Case A or B above.
   - Create coupon, apply/create subscription, stamp Stripe IDs on the row, mark `fulfilled`.
   - `invalidateSubscriptionCaches(recipientId)` + `refreshSession(recipientId)`.
   - Fire notifications (below). On error: mark `failed`, log to Axiom, **return non-2xx** so Stripe retries (fulfillment is idempotent via status check + re-entrant coupon lookup by `metadata.giftId`).

## Refunds / chargebacks

Extend the existing `charge.refunded` / `charge.dispute.created` branch (`webhooks/stripe.ts:334`): look up `MembershipGift` by `stripePaymentIntentId` →

- Coupon not yet exhausted: delete the coupon / remove the discount from the subscription.
- Gift-created sub (Case B): cancel it immediately.
- Mark row `revoked`. Buzz already granted for elapsed months is not clawed back in v1 (matches how membership refunds behave today).

## UI

- **Entry points**:
  - Pricing page (`src/pages/pricing/index.tsx`): "Gift this tier" secondary action per plan card.
  - User profile action menu: "Gift a membership" (same placement pattern as `TipBuzzButton`).
- **Gift modal** (dialog-registry): user autocomplete (reuse the user QuickSearch/autocomplete pieces, `user.getAll` username search), tier + months selectors, live price, message + anonymous toggle → redirect to Stripe Checkout.
- **Success page**: reuse `/payment/success` with a gift variant message.
- **Recipient surfaces**:
  - Notification + optional email ("X gifted you N months of Gold!").
  - Membership page (`/user/membership`): show gift state — "Gifted membership — N months remaining" (derivable from the Stripe discount / `cancel_at`), and for Case B a "Keep my membership" CTA (add payment method + clear `cancel_at`).
- **Gifter surface**: a "Gifts sent" list (could live under account → payments) showing status. v1 can skip this if we want to trim scope.
- **Feature flag**: `giftMemberships` in `feature-flags.service.ts` (start `['mod']`, roll to `['public']`), gating entry points and the tRPC mutations.

## Notifications

New `membership-gift.notifications.ts` (pattern: `buzz.notifications.ts` tip-received):

- `membership-gift-received` → recipient (respects `anonymous`).
- `membership-gift-fulfilled` → gifter confirmation.
- Optional transactional email for the recipient (template pattern: `redeemableCodePurchase.email.ts`).

## Work breakdown

| Phase                        | Scope                                                                                                                                                                                                                       | Touches                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. Schema + service skeleton | `MembershipGift` model + migration SQL; `membership-gift.service.ts` (create/fulfill/revoke, fully unit-testable); `membershipGift.router.ts` + zod schema                                                                  | `packages/civitai-db-schema/*`, `src/server/{services,routers,schema}`      |
| 2. Checkout + webhook        | checkout-session mutation; `checkout.session.completed` + `charge.refunded` branches                                                                                                                                        | `src/server/services/stripe.service.ts`, `src/pages/api/webhooks/stripe.ts` |
| 3. Fulfillment logic         | Case A/B, coupon creation, cancel_at handling, cache/session invalidation, edge-case matrix                                                                                                                                 | `membership-gift.service.ts`                                                |
| 4. UI                        | modal, entry points, membership-page gift state, "keep membership" CTA                                                                                                                                                      | `src/components/*`, `src/pages/pricing`, `/user/membership`                 |
| 5. Notifications             | processors + optional email                                                                                                                                                                                                 | `src/server/notifications/*`, `src/server/email/templates`                  |
| 6. Testing + rollout         | unit tests for fulfillment matrix; debug endpoint `src/pages/api/testing/gift-membership.ts` (WebhookEndpoint, per-userId scoped) to simulate fulfillment/refund without paying; Stripe test-clock QA; feature flag rollout | `src/server/services/__tests__`, `src/pages/api/testing`                    |

### Implementation notes (as built)

- **Gift page**: `/pricing/gift` (`src/pages/pricing/gift.tsx`; SSR-gated on `giftMemberships` + login) — recipient picker (QuickSearchDropdown → CreatorCardV2 once selected), selectable tier cards with the selected tier's `PlanBenefitList` (same presentation as the upgrade modal), months 1/3/6, message + anonymous, sticky order summary, redirects to Stripe Checkout. Prefill via `?userId=` / `?tier=`. (Started as a modal; promoted to a page for a nicer purchase experience.)
- **Entry points**: `PlanCard` "Gift this tier" → `/pricing/gift?tier=…` (Stripe products, giftable tiers only) and `UserContextMenu` "Gift a membership" → `/pricing/gift?userId=…` — both behind `features.giftMemberships`.
- **Keep my membership**: `keepGiftMembership` service + `membershipGift.keepMembership` mutation. Clears `cancel_at`/`cancel_at_period_end`; if the customer has no payment method it returns a Stripe billing-portal (`payment_method_update`) URL and the membership page retries via `?flow=keep-membership` on return. Membership page shows a teal gift alert (detected via subscription `metadata.membershipGiftId`) instead of the red cancellation warning.
- **Gifts list**: `MembershipGiftsCard` on `/user/account` (next to the subscription card) — received gifts (gifter unless anonymous, tier, months, message, date) and sent gifts (recipient, status badge, date), plus a "Gift a membership" shortcut. Hidden when the user has no gifts.
- **Debug endpoint**: `POST /api/testing/gift-membership?token=…` — `dump` / `giftability` / `create-gift` / `fulfill` / `revoke` / `reset` (fulfill/revoke hit real test-mode Stripe).
- **Tests**: 28 unit tests in `src/server/services/__tests__/membership-gift.service.test.ts` covering giftability, checkout, fulfillment matrix (extend, deferred-cancel, create, annual/billing-issue failures), revoke idempotency, and keep-membership.

## Decisions (v1)

1. **Tier mismatch** — locked: when the recipient already has an active green sub, the gift must match their current tier (UI pre-selects and locks the tier after picking the recipient; service rejects mismatches). Revisit post-v1.
   @dev: Lets lock it for V1 at least.

2. **Annual-interval recipients** — blocked in v1 (a repeating 100%-off coupon would zero a full annual invoice). Service returns `blocked: 'annual-interval'`; UI explains why.
   @dev: Block them in the meantime.

3. **Month options / pricing** — 1, 3, or 6 months only; flat months × the tier's monthly price, no bundle discount. (12 months dropped.)
   @dev: lets do 1, 3 and 6 months. No bundle.

4. **Self-gifting** — allowed; effectively prepaying your own membership. Watch how it's used.
   @dev: Lets allow it and see how it goes.

## Open questions (@dev)

1. **Recipient sub in `past_due`/`paused`** — apply anyway, credit, or fail-with-support-status? v1 proposal (currently implemented): only `active`/`trialing` get Case A; no-subscription (or terminal-status) recipients get Case B; anything else is blocked at purchase time with a billing-issue message.

2. **Anonymous gifting + message** — included in the schema above; cut if you want to trim v1.

3. **Refund policy surface** — should refunding auto-revoke (as planned) also claw back Buzz already granted for elapsed gift months? v1 plan: no clawback.

4. **Buzz color check** — gifted green memberships grant **green** monthly Buzz (product metadata `buzzType: 'green'` drives `toAccountType` in `manageInvoicePaid`). Confirm that's the intent for gifts too (I assume yes since these are real Stripe products).
