# Merch: Blue Buzz Reward Loop

**Status:** Server core BUILT (typechecks clean) — adam. Needs Shopify secrets + claim UI + migration apply before live.

## Build status (2026-06-29)

**Done (server, typecheck-clean):**
- Env: `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_WEBHOOK_SECRET` / `SHOPIFY_ADMIN_TOKEN` (`server-schema.ts` + `.env-example`).
- Migration: `prisma/migrations/20260629000000_shopify_merch_blue_buzz/` — `ShopifyCustomerLink` +
  `ShopifyMerchOrder` + `ShopifyMerchOrderStatus` enum. Models added to `schema.full.prisma` (the tracked
  source; root `prisma/schema.prisma` is gitignored/generated). **NOT applied** — apply SQL manually per repo rule.
- `src/server/utils/merch-buzz.ts` — pure buzz math: 250 Blue Buzz/$1 × coupon multiplier (`MERCH_BUZZ_COUPON_MULTIPLIERS`).
- `src/server/services/merch.service.ts` — `processShopifyOrderPaid` (record + auto-grant if linked) and
  `claimMerchOrder` (verify email, persist customer→user link, back-pay pending orders). Grants via
  `createBuzzTransaction` (Reward, `blue`, idempotent `externalTransactionId: merchPurchase:<orderId>`).
- `src/pages/api/webhooks/shopify.ts` — HMAC-verified (`X-Shopify-Hmac-Sha256`, raw body), handles `orders/paid`.

**Claim flow (#2) — BUILT 2026-06-29:**
- `src/server/services/merch.service.ts` — `getClaimableMerchOrder`, `claimMerchOrder` (instant if order
  email == verified Civitai email), `requestMerchClaimConfirmation` (mismatch: user asserts order email →
  only if it matches the email on file do we send a signed confirmation link to that address),
  `confirmMerchClaim` (HMAC token via `NEXTAUTH_SECRET`, 24h exp, bound to order+userId). Per-user Redis
  rate-limit (20 / 10 min, fail-open). Shopify never grants — it only hands off the order id.
- `src/pages/merch/claim.tsx` — handles `?order=<id>` (claim / mismatch-email entry) and `?token=` (confirm).
- `src/server/routers/merch.router.ts` (registered as `merch`) + `src/server/schema/merch.schema.ts`.
- Email: `src/server/email/templates/merchClaimConfirmation.email.ts`.

### Shopify order-status page snippet (paste into Settings → Checkout → Additional scripts)
```liquid
{% comment %} Civitai Blue Buzz claim — only shown until the customer is linked {% endcomment %}
{% unless customer.metafields.civitai.user_id %}
<div style="margin-top:1rem;padding:1rem;border:1px solid #e3e3e3;border-radius:8px;text-align:center;">
  <p style="margin:0 0 .5rem;font-weight:600;">⚡ Claim your Civitai Blue Buzz</p>
  <p style="margin:0 0 .75rem;color:#555;">This merch order earns Blue Buzz on Civitai.</p>
  <a href="https://civitai.com/merch/claim?order={{ order.id }}"
     style="display:inline-block;background:#1971c2;color:#fff;padding:.5rem 1rem;border-radius:6px;text-decoration:none;">
    Claim my Buzz
  </a>
</div>
{% endunless %}
```
**`{{ order.id }}` must equal the webhook payload `id`** (it does — both are the numeric order id we store as
`shopifyOrderId`). The `{% unless %}` hides the prompt for already-linked customers: on first claim we write a
`civitai.user_id` metafield onto the Shopify customer (`setCustomerCivitaiUserId`, via `SHOPIFY_ADMIN_TOKEN`), and
their orders auto-grant from then on. **Caveat:** on Shopify Plus / checkout-extensibility stores the Liquid
"Additional scripts" order-status page is deprecated — there you'd add this as a Thank-you/Order-status **UI
extension** (app block) reading the same metafield + linking to the same URL.

**Remaining:**
- Register the Shopify webhook → `/api/webhooks/shopify` for `orders/paid` (needs `SHOPIFY_WEBHOOK_SECRET`).
- Paste the snippet (or add the UI extension) on the Shopify order-status page.
- Flag-gate / ramp to testers; decide refund handling (currently: ignore + monitor).
- Apply the migration to preview/staging/prod manually.
- Optional later: #3 cart-attribute identity to skip claiming for shop-from-Civitai traffic.

---

**Sibling work:** Printful/Shopify creator pipeline → `docs/plans/merch-printful-creator-pipeline.md`.
**Author:** adam (2026-06-29)

---

## Thesis

Reward **Blue Buzz** when someone buys merch on **shop.civitai.com (Shopify)**.

- We can't sell Buzz for credit cards. We *can* sell physical merch and grant Buzz as a perk.
- Blue Buzz is restricted, but becomes usable for **unrestricted** generation once the user has a **membership**.
- Net: a legal-clean channel to inject usable Buzz + spread the Civitai brand.

Independent of the creator pipeline — buys of *any* merch (hand-built or creator-submitted) reward buzz.

---

## Decisions (locked 2026-06-29)

- **Identity = post-purchase claim + persistent link.** First time, a logged-in Civitai user enters their
  Shopify order # on a claim page. On claim we persist the Shopify-customer ↔ Civitai-user link so **future
  orders from that customer auto-redeem** (no claim step). Email is the natural join key from the order
  payload; store the Shopify `customer.id` too for stability.
- **Trigger = on payment** (`orders/paid`). Instant gratification. Accepted clawback risk on refund/cancel
  (see "Refund handling" below).
- **Rate = 250 Blue Buzz per $1** of merch subtotal (25% of dollar value), **boostable via coupon codes**.
  A coupon→multiplier map lets promos pay out more (e.g. a 2x code → 500/$1).

---

## How the loop works

```
Customer buys merch → Shopify orders/paid webhook → Civitai app
   ├─ customer already linked?  → grant Blue Buzz immediately (idempotent on order id)
   └─ not linked yet            → stash pending order; user claims on a claim page,
                                   which links customer→userId AND grants this + any pending orders
```

### Data model (new)
- **`ShopifyCustomerLink`** — maps a Shopify customer (`shopifyCustomerId`, `email`) → Civitai `userId`.
  Created on first successful claim; consulted by the webhook for auto-redeem.
- **Pending/granted orders** — need to record processed Shopify order ids for idempotency (the reward
  `getKey` on order id covers double-grant; we also need to hold *unclaimed* orders so a later claim can
  back-pay them). Likely a small `ShopifyMerchOrder` table (orderId, email, subtotal, couponCodes,
  status: pending|granted, userId nullable, buzzAmount).

### Building blocks (already in repo)
- Buzz rewards: `src/server/rewards/active/*.reward.ts` via `createBuzzEvent(...)` (`base.reward.ts`).
  **Blue Buzz = `toAccountType: 'blue'`.** Minimal example: `firstDailyPost.reward.ts`.
- Webhook endpoints: `src/pages/api/webhooks/*` (HMAC-verified). HttpCaller pattern: `src/server/http/emerchantpay/`.
- Feature flags: Flipt (ramp to testers first).

### Build steps
1. Migration: `ShopifyCustomerLink` + `ShopifyMerchOrder` tables (manual-apply per repo convention).
2. `src/pages/api/webhooks/shopify.ts` — verify `X-Shopify-Hmac-Sha256`, handle `orders/paid`:
   compute buzz (subtotal × rate × coupon multiplier), record the order, and if customer is linked → grant now.
3. `src/server/rewards/active/merchPurchased.reward.ts` — `toAccountType:'blue'`, amount = computed buzz,
   `getKey` on Shopify order id for idempotency, sensible per-order cap.
4. Claim endpoint + page: logged-in user submits order # → verify it belongs to their email/order →
   create `ShopifyCustomerLink` → grant this order + any pending orders for that customer.
5. **Coupon multiplier config** — a `couponCode → multiplier` map (start as a constant in
   `server/common/constants.ts`; promote to DB/Flipt later if it needs to change without deploy).
6. Flag-gate, ramp to testers.

### Refund handling (decide during build)
On-payment grant means a refunded order already paid out buzz. Options: ignore (small abuse surface, buzz is
"blue"/restricted anyway), or subscribe to `refunds/create` and debit. Start with ignore + monitor.

### Secrets needed
- Shopify Admin API token + shop domain + **webhook signing secret** → `SHOPIFY_*` env vars
  (`src/env/server-schema.ts` + `.env-example`).

---

## Decisions log
- 2026-06-29: Split from the Printful doc; adam owns this. (Justin)
- 2026-06-29: Identity = post-purchase claim + persistent link/auto-redeem; trigger = on payment;
  rate = 250 Blue Buzz/$1 (25%) boostable by coupon codes. (Justin)
