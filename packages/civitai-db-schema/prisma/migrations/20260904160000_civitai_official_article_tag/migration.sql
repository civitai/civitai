-- Creates the tag that marks an article as published by Civitai rather than by a community
-- author. Justin, 2026-09-04, after choosing option A on the design question.
--
-- A TAG and not a category, deliberately: an article carries exactly one category
-- (ArticleUpsertForm makes the author pick one) and official articles span several of them --
-- an official announcement and an official guide are both official.
--
-- 🔴 `adminOnly` is the whole permission model. `upsertArticleHandler` refuses any article
-- carrying an adminOnly tag from a caller without the `adminTags` feature (mod, or granted).
-- Clearing this column does not disable a badge; it makes the badge FORGEABLE by any user,
-- because article tags attach by NAME through `connectOrCreate` and anyone can type a name.
--
-- 🔴 Renaming this row silently unsets every badge. The client matches on the name, from
-- `src/shared/constants/official-article.constants.ts`. Rename in one place only and the badge
-- disappears with no error anywhere.
--
-- Measured on prod 2026-09-04 before writing this:
--   * `SELECT count(*) FROM "Tag" WHERE "adminOnly"` -> 0. Nothing has ever used this column,
--     so this row is the first thing the guard above will ever refuse.
--   * A tag named `official` already exists (id 123833), targets Post, is NOT adminOnly, and is
--     on 8 posts. It is deliberately NOT reused: flipping it would retroactively mark 8 existing
--     posts as official, and users have already applied it themselves.
--   * No tag named `civitai official` exists.
--
-- Idempotent. `Tag.name` is unique, so a second run updates the existing row to the intended
-- state rather than failing or duplicating -- which also repairs a row whose `adminOnly` was
-- cleared by hand.
INSERT INTO "Tag" ("name", "target", "adminOnly", "unlisted", "createdAt", "updatedAt")
VALUES ('civitai official', ARRAY['Article']::"TagTarget"[], true, false, NOW(), NOW())
ON CONFLICT ("name") DO UPDATE
  SET "target" = ARRAY['Article']::"TagTarget"[],
      "adminOnly" = true,
      "updatedAt" = NOW();
