-- W3 Slice 1 — App Blocks attribution flow B (page Buzz PURCHASE).
--
-- Extend the block_buzz_attribution scope CHECK constraint to accept the new
-- `viewer_global` scope (W10 full-page apps, entity=none). A Buzz purchase made
-- inside a page surface mints with a synthetic `page_<appBlockId>` instanceId,
-- which the FIN-1 server re-derivation now resolves to `viewer_global`
-- (placeholder 0% publisher share — see rate-card.ts RATE_CARD_V3). Without
-- this constraint change the webhook INSERT of a page-purchase row would be
-- rejected by the existing IN (...) list.
--
-- ⚠️ MANUAL-APPLY (civitai DB rule): this file is committed for history but is
--    NOT auto-applied. A human must run it via psql/retool on:
--      1. prod nvme0  (role=postgres CNPG cluster — the main civitai DB)
--      2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)
--    BEFORE the code that writes `viewer_global` deploys — otherwise the
--    CHECK rejects the INSERT and the page purchase's attribution is lost.
--
-- Behavior-preserving for existing rows: it only WIDENS the allowed set; no
-- existing row uses `viewer_global` (the scope is net-new in this PR).

ALTER TABLE "block_buzz_attribution"
  DROP CONSTRAINT IF EXISTS "block_buzz_attribution_scope_check";

ALTER TABLE "block_buzz_attribution"
  ADD CONSTRAINT "block_buzz_attribution_scope_check"
  CHECK ("scope" IN (
    'per_model_install',
    'publisher_all_my_models',
    'viewer_personal',
    'platform_default',
    'viewer_global'
  ));
