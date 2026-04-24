# Referral Program v2 — Review Walkthrough

**PR**: https://github.com/civitai/civitai/pull/2178
**Branch**: `feature/referral-program-v2` (rebased onto `main` 2026-04-21)
**Status**: 6 commits, typecheck clean, 24 unit tests green

Use this as your checklist. Mark items complete inline with `@justin: ✅` / `@justin: ❌ <why>`.

---

## 0. Do this BEFORE reviewing

These setup steps make the feature actually testable. Without them you can read the code but can't exercise it.

### 0.1 Apply migrations (prod is fine — both are purely additive)

```bash
pnpm run db:migrate
```

Runs both:
- `20260420153258_add_referral_program_v2` — `ReferralReward`, `ReferralMilestone`, `ReferralRedemption` tables + enums, extends `UserReferral` with `firstPaidAt`/`paidMonthCount`
- `20260420170000_add_referral_attribution` — `ReferralAttribution` table + indexes

**No drops, no type changes, no renames.** Safe to apply with production traffic. Existing Stripe webhook hooks are wrapped in `.catch(handleLogError)` so they won't affect invoice processing if referral code throws.

### 0.2 Create 3 Civitai-provider Products for redemption grants

**Without this, `redeemTokens` throws and tokens stay unspent** (safe failure, but users can't redeem).

Insert into Postgres:

```sql
INSERT INTO "Product" (id, name, description, metadata, provider, active)
VALUES
  ('civitai-referral-bronze', 'Referral Bronze Perks',
   'Temporary Bronze membership perks granted via referral redemption',
   '{"tier":"bronze","monthlyBuzz":0,"referralGrantable":true,"badgeType":"none"}'::jsonb,
   'Civitai', true),
  ('civitai-referral-silver', 'Referral Silver Perks',
   'Temporary Silver membership perks granted via referral redemption',
   '{"tier":"silver","monthlyBuzz":0,"referralGrantable":true,"badgeType":"none"}'::jsonb,
   'Civitai', true),
  ('civitai-referral-gold', 'Referral Gold Perks',
   'Temporary Gold membership perks granted via referral redemption',
   '{"tier":"gold","monthlyBuzz":0,"referralGrantable":true,"badgeType":"none"}'::jsonb,
   'Civitai', true);

INSERT INTO "Price" (id, "productId", currency, "unitAmount", active, interval, description, provider, metadata)
VALUES
  ('civitai-referral-bronze-price', 'civitai-referral-bronze', 'USD', 0, true, 'month',
   'Bronze referral grant', 'Civitai', '{}'::jsonb),
  ('civitai-referral-silver-price', 'civitai-referral-silver', 'USD', 0, true, 'month',
   'Silver referral grant', 'Civitai', '{}'::jsonb),
  ('civitai-referral-gold-price', 'civitai-referral-gold', 'USD', 0, true, 'month',
   'Gold referral grant', 'Civitai', '{}'::jsonb);

UPDATE "Product" SET "defaultPriceId" = id || '-price'
WHERE id IN ('civitai-referral-bronze', 'civitai-referral-silver', 'civitai-referral-gold');
```

**@ai:*** Verify column names + provider enum value against live schema before running. I've inferred from Prisma but haven't queried prod.

### 0.3 Configure Flipt flag

```bash
.claude/skills/flipt  # or via flipt CLI
```

Create flag `referral-program-v2` (default: disabled). Nav link `/user/referrals`, the page, and all UI gate on this.

For your review: enable it for your own user only. In Flipt, add a segment targeting `userId = <yours>` and match-rule the flag ON for that segment. Leave off for everyone else until launch.

### 0.4 Terms doc placeholders

`src/static-content/referrals/terms.md` has two `[CONFIRM: ...]` placeholders:
1. Effective Date — fill in with planned launch date
2. Governing law jurisdiction — defaults to Delaware per main TOS section 19.2, override if needed

---

## 1. Design docs (read first)

- [Design](referral-program.md) — mechanics, data model, signal matrix, overlap stacking plan, attribution plan, notifications. HackMD mirror: https://hackmd.io/@civitai/HJVlstA3Wl
- [Terms](referral-program-terms.md) — self-written program terms, section-by-section. HackMD mirror: https://hackmd.io/@civitai/SyjY8zNTZx

Key decisions locked via `@justin:` / `@ai:` comments in the design doc:
- 3 paid months per referee cap (Gold referee → up to 9 tokens)
- 25% of tier monthlyBuzz as Blue Buzz to referee on first paid membership
- 10% Blue Buzz kickback on referee yellow Buzz purchases
- 90-day token expiry
- 7-day settlement window (post-window chargebacks = write-off)
- Single auto-generated code per user
- Paddle explicitly NOT wired (Paddle is dead per header comment)

---

## 2. Code review — by area

### 2.1 Schema + migrations (~120 LOC)

**Source of truth**: `prisma/schema.full.prisma` (NOT `schema.prisma` — that's auto-generated).

Models added:
- `ReferralReward` — `@@unique([kind, sourceEventId])` for webhook-retry idempotency; `@@index([status, settledAt])` supports the settlement cron scan
- `ReferralMilestone` — `@@unique([userId, threshold])` prevents double-award races
- `ReferralRedemption` — history log
- `ReferralAttribution` — FK to `UserReferralCode` + payment identifiers (Stripe PI / invoice / charge / PM fingerprint + IP), indexed for "all events for this code/card/IP" mod queries

Extensions to existing:
- `UserReferral`: `firstPaidAt`, `paidMonthCount`

Enums: `ReferralRewardStatus`, `ReferralRewardKind`

**Things to check**:
- `sourceEventId` is NOT NULL — any codepath that might not have one?
- Cascading deletes on `referralCode` / `referee` drops correct for you?
- Index coverage matches the hot queries (settlement cron, dashboard, mod review)

### 2.2 Service layer — `src/server/services/referral.service.ts` (~750 LOC)

Top-to-bottom tour:

| Function | What it does |
|---|---|
| `emitSignal`, `recordAttribution` | Infrastructure: signal fan-out with Axiom error log, Postgres attribution write (best-effort) |
| `resolveReferrerForReferee` | Central guard: checks bound referrer, min account age, self-referral block |
| `bindReferralCodeForUser` | Attaches a ref code to an existing user's `UserReferral` (called from invoice webhook when `ref_code` is in Stripe subscription metadata) |
| `recordMembershipPaymentReward` | Fires on `invoice.paid`: creates `MembershipToken` reward, increments `paidMonthCount`, grants referee bonus on first payment. Unique-violation swallowed = idempotent |
| `recordBuzzPurchaseKickback` | Fires on `payment_intent.succeeded` for `buzzPurchase`: 10% Blue Buzz as `BuzzKickback` reward |
| `settleDueRewards` + `settleRewardRow` | Cron: flips Pending → Settled after 7 days, grants Blue Buzz via `createBuzzTransaction`. CAS updateMany blocks double-settle; buzz grant failure reverts claim |
| `revokeForChargeback` | Within 7 days: clean revoke Pending. Post-window: negative buzz txn to claw back Settled |
| `awardMilestones` | On each kickback settlement: awards any new milestones hit. Unique constraint makes concurrent calls safe. Grants placeholder cosmetic on 1M |
| `expireSettledTokens` | Daily: flips Settled → Expired at 90 days; fires expiring-soon signal + notification at T-7 |
| `getReferrerBalance` | Single groupBy across status+kind for dashboard |
| `collapseTierQueue` (exported for tests) | Pure: sorts chunks tier-DESC, collapses same-tier, drops zero-duration |
| `grantReferralSubscription` | Redemption: pools active-remaining + queued + new chunk, writes highest as active, rest to `metadata.referralQueue`. **Exploit-proof — each chunk keeps its tier** |
| `advanceReferralSubscriptions` | Cron: for referral subs past `currentPeriodEnd`, promotes next queue entry or cancels if empty |
| `redeemTokens` | Transaction wrapper: `FOR UPDATE` lock on token rows, consume (full + partial), call `grantReferralSubscription`, create `ReferralRedemption` |

**Places to scrutinize hardest**:
- The `try/catch` on `dbWrite.$transaction` in `recordMembershipPaymentReward` — confirm P2002 handling
- `settleRewardRow` rollback on buzz-grant failure — confirm state stays Pending after revert
- `revokeForChargeback` negative buzz transaction uses `TransactionType.ChargeBack` + `externalTransactionId: 'referral-clawback:<id>'` — verify buzz service accepts this

### 2.3 Webhook hooks

**`src/pages/api/webhooks/stripe.ts`**:
- Added `charge.refunded`, `charge.dispute.created` to `relevantEvents`
- Chargeback handler looks up PI → invoice via Stripe API, calls `revokeForChargeback` with BOTH IDs (membership rewards use invoice.id as sourceEventId, buzz rewards use PI id)
- `payment_intent.succeeded` / `buzzPurchase` path passes card fingerprint + charge id through to `recordBuzzPurchaseKickback`
- Rebase preserved upstream's zod parse of PI metadata + Axiom log helper

**`src/server/services/stripe.service.ts` :: `manageInvoicePaid`**:
- After the existing buzz grant, calls `bindReferralCodeForUser` (if `subscription_details.metadata.ref_code` exists) then `recordMembershipPaymentReward`
- Passes invoice/PI/charge IDs through for attribution

**`src/server/services/stripe.service.ts` :: `createSubscribeSession`**:
- Accepts new `refCode` param
- Threads it to Stripe checkout session as `subscription_data.metadata.ref_code` so it survives to the first invoice

### 2.4 Cron jobs (`src/server/jobs/referral-program-jobs.ts` + run-jobs registry)

Three jobs:
- `settle-referral-rewards` — every 15 min — flip pending→settled, grant buzz
- `advance-referral-subs` — hourly at `:05` — promote next queue chunk or cancel
- `expire-referral-tokens` — daily at 03:17 — flip settled→expired, fire expiring-soon

Check: cron cadences, job registration in `[[...run]].ts`.

### 2.5 tRPC router — `src/server/routers/referral.router.ts` (~170 LOC)

Endpoints:
- `getDashboard` (protected) — one query pulls code, balance, recent rewards, milestones, redemptions, conversion count, active referral grant with timeline
- `redeem` (protected) — wraps `redeemTokens`
- `getShopOffers` (protected) — returns shop items from constants
- `getTierBonuses` (public) — returns `{ monthlyBuzzByTier, refereeBonusPct }` for the checkout banner to compute and display bonus amounts
- `trackCheckoutView` (public) — fires `referral:checkout-viewed` signal to referrer

Code generation (`generateCode`) uses unseeded `Math.random` over a 32^8 space. Collision risk negligible but not zero; no retry loop. Flag if that bothers you.

### 2.6 Signals + notifications

**Signals** (`src/server/common/enums.ts`, emitted from service, subscribed in `src/components/Referrals/ReferralSignals.ts`):
- `referral:purchase-pending` — live dashboard update
- `referral:settled` — live dashboard update + toast
- `referral:milestone` — toast
- `referral:tier-granted` — toast
- `referral:clawback` — invalidate dashboard
- `referral:token-expiring-soon` — invalidate dashboard
- `referral:checkout-viewed` — (enum only; no client hook wired yet — v1.1)
- `referral:click` — (enum only; no emitter yet — v1.1)

**Notifications** (persistent, email-eligible, `src/server/notifications/referral.notifications.ts`):
- `referral-reward-settled` — referrer
- `referral-milestone-hit` — referrer
- `referral-token-expiring` — referrer (deduped per-user-per-expiry-date)
- `referral-welcome-bonus` — referee (non-toggleable)

Registered in `src/server/notifications/utils.notifications.ts`.

### 2.7 UI

**`src/pages/user/referrals.tsx`** — dashboard.
- Hero: code display, copy-code / copy-link, X / Reddit / Discord share buttons, Program Terms link
- Stats grid: Conversions, Lifetime Blue Buzz, Next Milestone progress
- **`ReferralTimelineProgress`** — segmented tier bar with tooltips (shows only when active referral sub exists)
- Tokens panel: settled/pending counts, Redeem button → shop modal
- Shop modal: 6 tier×duration offers, per-item affordability check, disclaimer text about queue behavior
- Recent activity feed (anonymized table of rewards)
- Redemption history table

**`src/components/Referrals/ReferralCheckoutBanner.tsx`** — on `/pricing`.
- Fetches `getTierBonuses` for per-tier monthly-buzz values
- If `ref_code` cookie set: shows bonus amounts ("Bronze: 2,500 Blue Buzz, Silver: 6,250...")
- If no cookie: shows input field for manual code entry
- No NSFW mention in copy (per your earlier direction)

**Nav link** — `src/components/AppLayout/AppHeader/hooks.tsx`:
- Added "Referrals" entry under user menu, gated on `features.referralProgramV2`

### 2.8 Tests — `src/server/services/__tests__/referral.service.test.ts`

24 cases. Run: `pnpm exec vitest run src/server/services/__tests__/referral.service.test.ts`

Coverage:
- `collapseTierQueue`: sort, collapse, zero-drop, **exploit prevention** (Bronze stacked with Gold stays Bronze)
- `recordMembershipPaymentReward`: no-referrer, cap, first-payment bonus, subsequent-month, P2002, min-age
- `recordBuzzPurchaseKickback`: skip without firstPaidAt, 10% rate
- `revokeForChargeback`: pending vs settled paths
- `awardMilestones`: no-op, qualifying thresholds, P2002 race
- `advanceReferralSubscriptions`: empty queue cancels, non-empty promotes, missing product skips

---

## 3. Manual smoke tests

Flag the Flipt flag ON for your user, then:

- [ ] Hit `/user/referrals` — dashboard renders with your auto-generated code
- [ ] Copy code button → clipboard
- [ ] Share buttons open correct prefilled intents
- [ ] With a second test account, visit `/?ref_code=<your-code>`, then `/pricing`
   - Banner should show "Using code XXX" with bonus amounts per tier
- [ ] Subscribe test account to Bronze via Stripe test card
   - Your dashboard: pending token appears in activity feed, timeline bar does NOT yet show (because first payment just happened, sub needs to be active)
   - Axiom / Postgres: `ReferralAttribution` row written with PI/invoice/charge IDs + card fingerprint
- [ ] Fast-forward 7 days (or manually update `settledAt` in Postgres), run `settle-referral-rewards` via `/api/webhooks/run-jobs`
   - Your pending token flips to settled
   - Notification arrives: "1 token settled…"
   - Referee gets welcome-bonus notification + 2,500 Blue Buzz in their account
- [ ] Buy buzz as referee via Stripe test charge
   - 10% Blue Buzz pending for you
   - Settlement cron flips it; milestone hit if total ≥ 1k
- [ ] Redeem 2 tokens → 1 month Bronze perks
   - Timeline bar appears on dashboard, Bronze segment at full width
   - Your `sessionUser.tier` should compute to Bronze (or higher if you have paid sub too)
   - `CustomerSubscription` row created with `buzzType='referral'`
- [ ] Refund the test membership via Stripe
   - `referral:clawback` signal fires, reward moves to Revoked
   - If already settled: negative buzz transaction created (`referral-clawback:<id>`)

---

## 4. Known gaps / deferred (not blocking launch)

- `referral:click` signal: enum defined, no emitter. v1.1.
- Paddle buzz kickback: explicitly skipped. Paddle is deprecated.
- Top Affiliate cosmetic: uses most-recent available cosmetic as placeholder until Ally authors a bespoke one. Swap the `findFirst` lookup in `awardMilestones` → `getTopAffiliateCosmeticId` for a hardcoded `cosmeticId`.
- `trackCheckoutView` has no rate limit (was flagged as low-priority per your direction).
- Dynamic redemption-vs-paid-tier UX warning — static disclaimer text only.

---

## 5. What I'd like you to review specifically

**Design-level**:
- Is `buzzType: 'referral'` the right approach for stacking? Any downstream code I missed that hard-codes the set of valid buzz types?
- Comfortable with the min-referrer-account-age check at 7 days? (Currently silently refuses all rewards for accounts younger than that)
- Milestone ladder numbers (1k / 10k / 50k / 200k / 1M) — fine or want recalibration?

**Code-level**:
- `revokeForChargeback` fires a negative `createBuzzTransaction` for settled rewards. Confirm that's the right mechanism (vs e.g. flagging a clawback event and doing a manual sweep).
- `advanceReferralSubscriptions` cancels the sub when queue empties. Any concern about `status='canceled'` showing up in downstream UI where users might be confused?
- `generateCode`: 32^8 alphabet, no collision retry. Ship or add retry loop?

**Ops-level**:
- Flipt rollout plan (internal → alpha → beta → GA percentages)
- Timing for the 3 Civitai-provider Products creation — before or concurrent with flag enable?

---

## 6. Sign-off checklist

- [ ] Migrations applied
- [ ] 3 referral products created
- [ ] Flipt flag created (disabled for everyone)
- [ ] Terms doc placeholders filled in
- [ ] Code review sections 2.1 - 2.8 walked
- [ ] Manual smoke test passed
- [ ] Design questions in section 5 answered
- [ ] Approve PR

---

## 7. Staged Experiment Scenarios (user ID 1)

Phase 1 data is pre-seeded directly into Postgres so Justin can walk the UI without waiting for any deploy. Later phases rely on `/api/testing/referrals` — that endpoint only lands in prod once this branch deploys. Until then, later phases need either (a) this branch deployed, or (b) a local dev server pointed at the staging or production DB.

**Prereq before any UI walk-through**:
- Branch code deployed to an env the browser can hit (prod after merge, or local `pnpm run dev`)
- Flipt flag `referral-program-v2` enabled (done; default-on globally)
- Logged in as user 1

Use this as a driver — once Justin (or I) verify each scenario end-to-end, tick the box.

### Phase 1 — already seeded

Seeded on prod DB (idempotent via `sourceEventId`): `MembershipToken` = 6 settled Bronze, `BuzzKickback` = 500 Blue Buzz settled (display-only, no buzz txn created).

- [ ] **1a. Dashboard renders with seeded state**
  - Visit `/user/referrals`
  - Hero shows code `5SFRSKKV` (user 1's existing code)
  - Stats card: "Lifetime Blue Buzz" = 500
  - Tokens panel: 6 settled, 0 pending
  - No timeline bar yet (no active referral sub)
- [ ] **1b. Share buttons work**
  - Copy code and copy link both put something in clipboard
  - X, Reddit, Discord buttons open the right prefilled intent pages
- [ ] **1c. Buzz dashboard + membership page callouts visible**
  - `/user/buzz-dashboard`: gradient ReferralCallout at top links to `/user/referrals`
  - `/user/membership`: compact ReferralCallout between title and alerts
- [ ] **1d. Redemption — 1 month Bronze (2 tokens)**
  - Open Redeem modal
  - Pick "1 month Bronze perks" (2 tokens)
  - After redeem: timeline bar appears (Bronze segment full width), remaining 4 tokens still settled
  - `CustomerSubscription` row created with `buzzType='referral'`, `productId='civitai-referral-bronze'`
  - `sessionUser.tier` should reflect Bronze (or higher if Justin already has a paid sub)

### Phase 2 — queue stacking (needs debug endpoint or manual SQL)

Purpose: verify the "chunks never cross tiers" queue logic.

```bash
# Grant a Gold-tier chunk on top of the active Bronze
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"enqueue-chunk","userId":1,"tier":"gold","durationDays":14}'
```

- [ ] **2a. Enqueue Gold behind Bronze**
  - Before: active Bronze, queue empty
  - After enqueue: active Bronze stays, queue has `[{tier:"gold", durationDays:14}]`
  - **Expected via queue sort**: Gold actually comes out FIRST if redeemed separately. This test mirrors cron advance behavior below.
- [ ] **2b. Advance subs — Gold promotes after Bronze expires**
  - `{"action":"advance-subs","userId":1}` — expires the active Bronze sub and promotes the next queue entry
  - Active should now be Gold
  - Timeline bar re-renders with Gold active + empty queue

### Phase 3 — spend events + settlement

```bash
# Fake an incoming paid membership attributed to user 1
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"bind-code","userId":<OTHER_USER>,"code":"5SFRSKKV"}'

curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"simulate-membership-payment","refereeId":<OTHER_USER>,"tier":"silver"}'
```

- [ ] **3a. Referee first paid Silver → referrer gets 2 pending tokens + welcome-bonus pending**
  - Pending card count increments by 2
  - User 1 sees `referral:purchase-pending` signal (live), notification arrives once settled
  - Other user gets `referral-welcome-bonus` notification + 6,250 Blue Buzz (25% of 25k monthly) once settled
- [ ] **3b. Settle immediately**
  - `{"action":"settle-all","userId":1}`
  - Pending → Settled
  - Activity feed shows two fresh rows
  - `ReferralAttribution` gets a `membership_payment` row (query Postgres to verify)
- [ ] **3c. Second month's payment**
  - `simulate-membership-payment` again with same tier
  - Pending tokens = 2 more, `paidMonthCount` on `UserReferral` now 2
- [ ] **3d. Third month — cap kicks in**
  - One more `simulate-membership-payment`, then a FOURTH
  - Fourth returns `rewardId: null`
  - `ReferralAttribution` row has `eventType='membership_payment_over_cap'`

### Phase 4 — buzz kickback + milestone

```bash
# Referee purchases 10k yellow buzz
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -d '{"action":"simulate-buzz-purchase","refereeId":<OTHER_USER>,"blueBuzz":10000}'
```

- [ ] **4a. Pending 1,000 Blue Buzz kickback appears for user 1**
- [ ] **4b. Settle**
  - `{"action":"settle-all","userId":1}`
  - Blue Buzz actually credited to user 1's blue buzz account (verify via buzz dashboard)
  - `referral:settled` signal fires → notification arrives
- [ ] **4c. 1k milestone hit**
  - `awardMilestones` runs inside settle — if lifetime ≥ 1000, `ReferralMilestone` row appears, +500 bonus reward created
  - Next settle cycle credits the +500 bonus

### Phase 5 — chargeback clawback

```bash
# Simulate a chargeback for the Phase 3 invoice
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -d '{"action":"simulate-chargeback","sourceEventId":"<invoice-id-from-phase-3>"}'
```

- [ ] **5a. Pending reward → Revoked (no buzz movement)**
- [ ] **5b. Settled reward → Revoked + negative `createBuzzTransaction`**
  - `ChargeBack` transaction type
  - `externalTransactionId: 'referral-clawback:<id>'`
  - User 1's Blue Buzz balance drops by the revoked amount

### Phase 6 — token expiry

```bash
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -d '{"action":"expire-tokens","userId":1}'
```

- [ ] All settled tokens flip to Expired
- [ ] `referral:token-expiring-soon` signal + notification fire at the T-7 warn window (today's run fires both since we force expiry immediately)
- [ ] Tokens panel now shows 0 settled

### Phase 7 — checkout banner

- [ ] Sign out / open incognito
- [ ] Visit `/?ref_code=5SFRSKKV` then `/pricing`
- [ ] ReferralCheckoutBanner shows:
  - "Using referral code 5SFRSKKV"
  - Per-tier bonus lines (Bronze 2,500 / Silver 6,250 / Gold 12,500 Blue Buzz)
  - "Program Terms" link resolves to `/content/referrals/terms`
- [ ] Clear code → input field re-appears
- [ ] Enter a different code manually → banner re-renders with that code
- [ ] Signed-in user who subscribes with the cookie set → Stripe subscription metadata carries `ref_code` (verify in Stripe dashboard)

### Phase 8 — reset

When done experimenting:

```bash
curl -X POST "<base>/api/testing/referrals?token=$WEBHOOK_TOKEN" \
  -d '{"action":"reset","userId":1,"confirm":true}'
```

Wipes all referral data for user 1 back to clean slate.
