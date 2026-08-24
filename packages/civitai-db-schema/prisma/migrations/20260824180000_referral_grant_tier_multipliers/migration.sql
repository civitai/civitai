-- Referral grants deliver the tier multipliers the referral dashboard advertises.
--
-- The three `civitai-referral-*` placeholder products carried no multipliers, so a redeemed
-- grant delivered neither the "1.5x daily rewards" nor the "1.05x purchases" its own
-- redemption card promises (ClickUp 868kv5az9). Decision by Justin, 2026-08-24: make the
-- product match the copy rather than change the copy.
--
-- `monthlyBuzz: 0` and `badgeType: "none"` stay as they are — the grant still conveys no Buzz
-- stipend and no badge. Only the two advertised multipliers are added.
--
-- Every numeric value in Product.metadata is stored Stripe-style, as a string.
--
-- 🔴 AFTER APPLYING: purge the multiplier cache. userMultipliersCache has a 1-day TTL and is only
-- busted per user; nothing invalidates it when a Product changes. Without a purge, grant holders
-- keep the perkless multiplier for up to 24h at whatever rate their entries happen to expire:
--
--   purge the 'packed:caches:multipliers-for-user' prefix (REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER)
--   with the cache-purge skill, then POST /api/admin/refresh-user-sessions

UPDATE "Product"
SET metadata = metadata || '{"rewardsMultiplier":"1.5","purchasesMultiplier":"1.05"}'::jsonb
WHERE id = 'civitai-referral-bronze';

UPDATE "Product"
SET metadata = metadata || '{"rewardsMultiplier":"2.5","purchasesMultiplier":"1.10"}'::jsonb
WHERE id = 'civitai-referral-silver';

UPDATE "Product"
SET metadata = metadata || '{"rewardsMultiplier":"4","purchasesMultiplier":"1.20"}'::jsonb
WHERE id = 'civitai-referral-gold';
