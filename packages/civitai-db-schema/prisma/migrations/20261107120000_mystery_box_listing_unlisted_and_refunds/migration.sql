-- Two constraint changes for mystery boxes.
--
-- 1. A box listing (a "CosmeticShopItem" with "itemDefinitionId" set) is never listed. It has no
--    "cosmeticId", and the storefront reads that as a pack; the box is sold only through its own
--    surface, which applies the feature flag, region and event checks. "listed" defaults to true, so a
--    box-listing insert must now pass listed = false explicitly.
-- 2. "BoxOpening"."rewardStatus" admits 'refunded': a moderator refund of an opened box takes the
--    reward back and keeps the opening as the record of the draw.
--
-- Apply before the moderator app deploy that refunds boxes: until then its opened-box refund fails
-- this CHECK and rolls back whole. Constraint changes only; no rows move. Runs in one transaction.

BEGIN;

ALTER TABLE "CosmeticShopItem" DROP CONSTRAINT IF EXISTS "CosmeticShopItem_item_listing_unlisted_check";
ALTER TABLE "CosmeticShopItem"
  ADD CONSTRAINT "CosmeticShopItem_item_listing_unlisted_check"
  CHECK ("itemDefinitionId" IS NULL OR NOT "listed");

ALTER TABLE "BoxOpening" DROP CONSTRAINT IF EXISTS "BoxOpening_rewardStatus_check";
ALTER TABLE "BoxOpening"
  ADD CONSTRAINT "BoxOpening_rewardStatus_check"
  CHECK ("rewardStatus" IN ('granted', 'refunded'));

COMMIT;
