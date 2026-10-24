-- ============================================================
-- Seed the user menu's default pins into KeyValue
-- ============================================================
-- What a viewer who never saved their own pins sees pinned at the top of the
-- user menu, read by `system.getUserMenuDefaultPins`. A JSON array of ids from
-- USER_MENU_ITEM_IDS (src/shared/constants/user-menu.constants.ts); unknown ids
-- are dropped when read. With no row the app falls back to the same constant,
-- so this seed only materializes the row so it can be edited.
--
-- MANUAL APPLY: the main civitai DB does NOT auto-apply migrations. A human
-- applies this per environment; CI / deploy does not run it.
--
-- ON CONFLICT DO NOTHING: re-runnable, and never resets a row already edited.
--
-- To change the defaults later (shows within a few minutes, once the edge
-- cache on the procedure expires):
--   UPDATE "KeyValue" SET "value" = '["collections","profile"]'::jsonb
--   WHERE "key" = 'userMenuDefaultPins';
INSERT INTO "KeyValue" ("key", "value")
VALUES ('userMenuDefaultPins', '["collections","profile"]'::jsonb)
ON CONFLICT ("key") DO NOTHING;
