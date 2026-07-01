# Merch: Blue Buzz Reward Loop

**Status:** Server core BUILT (typechecks clean) — adam. Needs Shopify secrets + claim UI + migration apply before live.

## Build status (2026-06-29)

**Done (server, typecheck-clean):**
- Env: `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_WEBHOOK_SECRET` / `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (+ optional static `SHOPIFY_ADMIN_TOKEN`) in `server-schema.ts` + `.env-example`.
- Migration: `prisma/migrations/20260629000000_shopify_merch_blue_buzz/` — `ShopifyCustomerLink` +
  `ShopifyMerchOrder` + `ShopifyMerchOrderStatus` enum. Models added to `schema.full.prisma` (the tracked
  source; root `prisma/schema.prisma` is gitignored/generated). **NOT applied** — apply SQL manually per repo rule.
- `src/server/utils/merch-buzz.ts` — pure buzz math: 250 Blue Buzz/$1 × coupon multiplier (`MERCH_BUZZ_COUPON_MULTIPLIERS`).
- `src/server/services/merch.service.ts` — `processShopifyOrderPaid` (record + auto-grant if linked) and
  `claimMerchOrder` (verify email, persist customer→user link, back-pay pending orders). Grants via
  `createBuzzTransaction` (Reward, `blue`, idempotent `externalTransactionId: merchPurchase:<orderId>`).
- `src/pages/api/webhooks/shopify.ts` — HMAC-verified (`X-Shopify-Hmac-Sha256`, raw body), handles `orders/paid`.

### Delivery + claim — webhook-driven email, signed-key claim (no Shopify-side UI)
shop.civitai.com is on **checkout extensibility**, so the Thank-you/Order-status page is not
merchant-editable Liquid (and isn't part of the theme). So there is **no Shopify-side UI** — claiming is
driven entirely by email:

- On `orders/paid`, `processShopifyOrderPaid` records the order and:
  - **already linked** → auto-grant + a **receipt** email (`merchBuzzCreditedEmail`, no link) naming the
    credited Civitai account.
  - **not linked** → an **invite** email (`merchClaimInviteEmail`) with the claim link.
  - Both emails send only on the **first** time we see an order (existence check → retry-safe), and never for
    `buzzAmount == 0`, no-email, or Shopify **test** orders.
- **Gapless claim — signed key.** The invite links to `/merch/claim?key=<signed>` where the key is an
  HMAC-signed order id (`signOrderKey`, `NEXTAUTH_SECRET`, 90-day exp). Because the link was delivered to the
  order's email, holding a valid key *is* the mailbox-ownership proof — so `claimMerchOrderByKey` links
  whatever Civitai account the clicker is signed into and grants immediately. No email-match, no confirmation.
- After first claim the Shopify customer is linked (`ShopifyCustomerLink`) + stamped with a `civitai.user_id`
  metafield, and pending orders are back-paid.
- Files: `src/pages/api/webhooks/shopify.ts`, `src/server/services/merch.service.ts`,
  `src/server/http/shopify/shopify.caller.ts`, `src/server/utils/merch-buzz.ts`, `merch` router + schema
  (single `claimByKey` procedure), `src/pages/merch/claim.tsx` (`?key=` only), the two email templates.
- Grants are idempotent (`externalTransactionId: merchPurchase:<id>`); claim endpoint is per-user rate-limited
  (fail-open). Per-order Buzz is capped (`MERCH_BUZZ_MAX_PER_ORDER`).

> The earlier unsigned `?order=` claim path + email-match/confirmation flow was removed 2026-06-30 (the
> signed-key email made it redundant; it was also a security finding — an order-existence oracle).

**Remaining:**
- Merge PR #2824 + deploy. (Secrets live in prod+preview; `orders/paid` webhook registered; migration
  applied to prod + dev — all done 2026-06-30.)
- Refund handling: currently **ignore + monitor** (Blue Buzz is non-withdrawable, so a refund-then-keep is
  bounded abuse, not cash loss). A `refunds/create` reversal handler is a possible fast-follow.
- Optional later: #3 cart-attribute identity to skip claiming for shop-from-Civitai traffic. Not needed — the
  webhook-driven email covers claiming.

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

### Secrets / Shopify app (provided by Fredrick 2026-06-30)
- Store: **`ff1592-5.myshopify.com`** (public `shop.civitai.com`); also the Printful-connected store.
- Admin auth = **client_credentials grant** (NOT a static token). The dev-dashboard custom app mints a
  ~24h token from `client_id` + `client_secret`:
  `POST https://{SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token` (grant_type=client_credentials). Our
  `shopify.caller.ts` mints + caches this in-process and re-mints on expiry. Admin API = GraphQL `2025-01`.
- Env vars → `SHOPIFY_SHOP_DOMAIN` (= `ff1592-5.myshopify.com`), `SHOPIFY_CLIENT_ID`,
  `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`. (`SHOPIFY_ADMIN_TOKEN` optional — static fallback only.)
- **Scopes already granted** on the app: `write_customers` (what we use, for the metafield),
  plus `read_all_orders`, `read_orders`, `write_products`, `write_publications`, `write_inventory`.
- Live keys are in team-private HackMD (Credentials section): https://hackmd.io/@civitai/HkUAujbQzg.
  **Rotate the client secret + move to the app secret store before production.**

---

## Decisions log
- 2026-06-29: Split from the Printful doc; adam owns this. (Justin)
- 2026-06-29: Identity = post-purchase claim + persistent link/auto-redeem; trigger = on payment;
  rate = 250 Blue Buzz/$1 (25%) boostable by coupon codes. (Justin)
