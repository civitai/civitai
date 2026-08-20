-- Chat themes come with a membership rather than being granted as cosmetics, so
-- the seeded ChatTheme cosmetics (and any grants made while testing them) have
-- nothing reading them. Only run this if 20260818210000_chat_theme_cosmetics was
-- applied; it was reverted before merge.
--
-- The `ChatTheme` value stays on the "CosmeticType" enum. Postgres cannot drop an
-- enum value without recreating the type, and a cosmetic-granted theme is the
-- shape a later pass would want anyway.
DELETE FROM "UserCosmetic" uc
USING "Cosmetic" c
WHERE uc."cosmeticId" = c.id AND c."type" = 'ChatTheme';

DELETE FROM "Cosmetic" WHERE "type" = 'ChatTheme';
