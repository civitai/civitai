-- Story Writers leaderboard: count an article as a story when the system category
-- (Article."systemCategoryId", set by the article category call) is 'story', not when its author tagged
-- it 'story'. Only that one predicate in the stored query changes; every other filter and weight stays.
-- Data row, not schema. Apply by hand; this repo does not run prisma migrate deploy. Apply AFTER the
-- category backfill has run (/api/admin/temp/article-category-backfill), or the board scores
-- only the few articles classified so far. Do not apply between 23:00 and 00:01 UTC
-- (prepare-leaderboard / deliver-leaderboard-cosmetics). Leaves "active" as it is.
--
-- Fail-closed: the live query must hash to the text 20261112170000_story_writer_leaderboard wrote
-- (md5 b0d929c8..., matched on the primary 2026-11-14), and the result must hash to the reviewed
-- switched text. Idempotent: a query already switched is left alone. RAISEs, changing nothing, when
-- the board row is missing, when its query is any other text, or when there is no 'story' article
-- category the category call can pick (the call is never offered adminOnly tags).

BEGIN;

DO $$
DECLARE
  old_predicate constant text := $old$  AND EXISTS (
    SELECT 1 FROM "TagsOnArticle" ta
    JOIN "Tag" t ON t.id = ta."tagId" AND t.name = 'story'
    JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
    JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
    WHERE ta."articleId" = a.id
  )$old$;
  new_predicate constant text := $new$  AND a."systemCategoryId" = (
    SELECT t.id FROM "Tag" t
    JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
    JOIN "Tag" p ON p.id = tt."fromTagId" AND p.name = 'article category'
    WHERE t.name = 'story'
  )$new$;
  live_md5 constant text := 'b0d929c8dfc788d5f5b2cac2fc813fd2';
  switched_md5 constant text := '36a04202e0a7ed9eeeae5dcc980a308a';
  current_query text;
  story_admin_only boolean;
BEGIN
  SELECT t."adminOnly" INTO story_admin_only
  FROM "Tag" t
  JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
  JOIN "Tag" p ON p.id = tt."fromTagId"
  WHERE t.name = 'story' AND p.name = 'article category';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no ''story'' tag under the ''article category'' system tag - the board would score nobody';
  END IF;
  IF story_admin_only THEN
    RAISE EXCEPTION 'the ''story'' article category is adminOnly - the category call never picks it, so the board would score nobody';
  END IF;

  SELECT query INTO current_query FROM "Leaderboard" WHERE id = 'story-writer' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'story-writer leaderboard row not found - apply 20261112170000_story_writer_leaderboard first';
  END IF;

  IF md5(current_query) = switched_md5 THEN
    RAISE NOTICE 'story-writer query already uses the system category - nothing to do';
    RETURN;
  END IF;
  IF md5(current_query) <> live_md5 THEN
    RAISE EXCEPTION 'story-writer query (md5 %) is not the reviewed text (md5 %) - it was edited; inspect SELECT query FROM "Leaderboard" WHERE id = ''story-writer'' and switch it by hand', md5(current_query), live_md5;
  END IF;

  UPDATE "Leaderboard" SET query = replace(query, old_predicate, new_predicate) WHERE id = 'story-writer';

  SELECT query INTO current_query FROM "Leaderboard" WHERE id = 'story-writer';
  IF md5(current_query) <> switched_md5 THEN
    RAISE EXCEPTION 'switched story-writer query hashes to %, not the reviewed %', md5(current_query), switched_md5;
  END IF;
END $$;

COMMIT;
