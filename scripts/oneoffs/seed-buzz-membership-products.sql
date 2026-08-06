-- Seed the perks-only "purchase with Buzz" membership catalog.
--
-- Context: docs/features/buzz-memberships.md
--
-- Creates one Product + one monthly Price per tier on the `Civitai` provider, marked
-- with `buzzPurchase: true` in product metadata. `getPlans` only returns these when
-- called with `buzzPurchase: true`, so running this does NOT change the existing
-- pricing page — the Buzz catalog is only reachable behind the `buzzMemberships`
-- feature flag.
--
-- Perks are COPIED from the live cash products (civitai-bronze / -silver / -gold) so the
-- badge, vault size, queue/quantity limits, steps and resources stay in sync with
-- whatever those tiers currently grant. Only the money-side fields are overridden:
--
--   purchasesMultiplier -> 1        (no bonus Buzz on purchases)
--   rewardsMultiplier   -> 1        (no bonus Buzz on daily rewards)
--   badgeType           -> 'none'   (no monthly badge)
--   buzzPurchase        -> true
--   buzzType            -> REMOVED  (see below)
--   monthlyBuzz         -> REMOVED  (no monthly Buzz, and keeps both crons off these rows)
--
-- THREE products total, shared by every site. `buzzType` is stripped rather than set:
-- these memberships grant no Buzz, so there is no colour to tag them with, and `getPlans`
-- deliberately skips the buzzType filter for the Buzz catalog. Run this ONCE per database
-- — not once per site. What the user pays with is the calling site's currency (Green on
-- civitai.com, Yellow on civitai.red), resolved server-side at purchase time and never
-- read off the product.
--
-- The per-month Buzz price is NOT stored: it is derived at runtime from the Price's
-- unitAmount by `getBuzzMembershipPrice` (cash × 1.25). The final SELECT prints what
-- each tier will cost so you can eyeball it before you leave. To pin a tier to a fixed
-- number instead, add a `buzzPrice` key to that product's metadata.
--
-- Idempotent: re-running updates the rows in place. Safe to run more than once.
--
-- HOW TO RUN — nothing to edit, run as-is, once per database:
--   psql "$DATABASE_URL" -f scripts/oneoffs/seed-buzz-membership-products.sql

BEGIN;

CREATE TEMP TABLE buzz_membership_config ON COMMIT DROP AS
SELECT
  -- Keep in sync with BUZZ_MEMBERSHIP_PREMIUM_MULTIPLIER (display only — the app
  -- derives the real price from this same constant in code).
  1.25::numeric AS premium;

-- Source tiers, in the order they should appear on the pricing page.
CREATE TEMP TABLE buzz_membership_source ON COMMIT DROP AS
SELECT
  p.id AS source_product_id,
  p.metadata ->> 'tier' AS tier,
  p.name,
  'civitai-buzz-' || (p.metadata ->> 'tier') AS product_id,
  'civitai-buzz-' || (p.metadata ->> 'tier') || '-monthly' AS price_id,
  p.metadata AS source_metadata
FROM "Product" p
WHERE p.id IN ('civitai-bronze', 'civitai-silver', 'civitai-gold');

-- Fail loudly rather than half-seeding if the cash catalog isn't what we expect.
DO $$
DECLARE
  found int;
BEGIN
  SELECT count(*) INTO found FROM buzz_membership_source;
  IF found <> 3 THEN
    RAISE EXCEPTION
      'Expected 3 source products (civitai-bronze/-silver/-gold), found %. Aborting.', found;
  END IF;
END $$;

-- 1. Products. `defaultPriceId` has no FK, so it can be set before the Price exists.
INSERT INTO "Product" (id, name, description, metadata, provider, active, "defaultPriceId")
SELECT
  s.product_id,
  s.name,
  s.name || ' membership perks, purchased with Buzz. One month, does not renew.',
  -- Keys dropped rather than overridden:
  --   buzzType    — these are site-agnostic; a leftover colour reads as a display hint
  --                 the membership doesn't earn.
  --   monthlyBuzz — deliverMonthlyCosmetics and the token-unlock cron both require it to
  --                 be present. Absent = neither cron ever matches these rows, which is
  --                 what we want: no monthly Buzz AND no monthly badge.
  (s.source_metadata - 'buzzType' - 'monthlyBuzz')
    || jsonb_build_object(
         'buzzPurchase', true,
         'purchasesMultiplier', 1,
         'rewardsMultiplier', 1,
         -- No monthly badge. Renders "No monthly badge" on the plan card, and matches how
         -- the referral-perks products are configured.
         'badgeType', 'none'
       ),
  'Civitai'::"PaymentProvider",
  true,
  s.price_id
FROM buzz_membership_source s
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  provider = EXCLUDED.provider,
  active = EXCLUDED.active,
  "defaultPriceId" = EXCLUDED."defaultPriceId";

-- 2. Prices. unitAmount mirrors the cash tier; the Buzz price is derived from it.
--    type/interval/intervalCount must match the cash prices or getPlans filters them out.
INSERT INTO "Price" (
  id, "productId", currency, "unitAmount", active, type, interval, "intervalCount",
  description, provider, metadata
)
SELECT
  s.price_id,
  s.product_id,
  src_price.currency,
  src_price."unitAmount",
  true,
  'recurring',
  'month',
  1,
  initcap(s.tier) || ' Tier - Monthly (Buzz)',
  'Civitai'::"PaymentProvider",
  '{"default":"true"}'::jsonb
FROM buzz_membership_source s
JOIN "Price" src_price
  ON src_price."productId" = s.source_product_id
 AND src_price.interval = 'month'
 AND src_price.active
ON CONFLICT (id) DO UPDATE SET
  "productId" = EXCLUDED."productId",
  currency = EXCLUDED.currency,
  "unitAmount" = EXCLUDED."unitAmount",
  active = EXCLUDED.active,
  type = EXCLUDED.type,
  interval = EXCLUDED.interval,
  "intervalCount" = EXCLUDED."intervalCount",
  description = EXCLUDED.description,
  provider = EXCLUDED.provider,
  metadata = EXCLUDED.metadata;

-- 3. What you just created, and what it will cost.
SELECT
  p.id AS product,
  p.metadata ->> 'tier' AS tier,
  -- Should print NULL on every row: these are site-agnostic.
  p.metadata ->> 'buzzType' AS buzz_colour,
  pr.id AS price,
  pr."unitAmount" / 100.0 AS cash_usd,
  round((pr."unitAmount" / 100.0) * 1000 * cfg.premium) AS buzz_price,
  -- Both should print NULL / 'none': no monthly Buzz, no monthly badge.
  p.metadata ->> 'monthlyBuzz' AS monthly_buzz,
  p.metadata ->> 'badgeType' AS badge_type,
  p.metadata ->> 'level' AS level,
  p.metadata ->> 'badge' AS badge
FROM "Product" p
JOIN "Price" pr ON pr.id = p."defaultPriceId"
CROSS JOIN buzz_membership_config cfg
WHERE (p.metadata ->> 'buzzPurchase')::boolean IS TRUE
ORDER BY pr."unitAmount";

COMMIT;

-- Expected output with today's cash prices — three rows, serving both sites:
--
--   product              | tier   | buzz_colour | cash_usd | buzz_price
--   ---------------------+--------+-------------+----------+-----------
--   civitai-buzz-bronze  | bronze | (null)      |    10.00 |      12500
--   civitai-buzz-silver  | silver | (null)      |    25.00 |      31250
--   civitai-buzz-gold    | gold   | (null)      |    50.00 |      62500
--
-- A non-null buzz_colour means the strip didn't take and the product would be treated as
-- belonging to one site. `buzz_price` is what the user pays, debited from the calling
-- site's currency (Green on civitai.com, Yellow on civitai.red), resolved in code.
--
--
-- TO PULL THE CATALOG BACK OFF SALE
-- Deactivate, don't delete — CustomerSubscription rows reference these products, and
-- existing Buzz memberships must keep resolving their tier until they lapse.
-- Deactivating hides them from getPlans immediately.
--
--   UPDATE "Product" SET active = false
--   WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE;
--
--   UPDATE "Price" SET active = false
--   WHERE "productId" IN (
--     SELECT id FROM "Product" WHERE (metadata ->> 'buzzPurchase')::boolean IS TRUE
--   );
