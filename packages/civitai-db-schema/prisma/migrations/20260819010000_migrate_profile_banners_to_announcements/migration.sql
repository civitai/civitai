-- Profile banner messages become profile-only announcements (CU 868ktjte1).
-- Applied by hand, like every migration here. Run AFTER 20260819000000_creator_announcements.
--
-- Counts (prod, 2026-08-19), for the runbook's before/after check:
-- First statement inserts 25,655: 27,806 rows hold a non-empty "message", 1,379 of those
-- sit on deleted users, leaving 26,427 live, and 772 of those contain HTML and are skipped.
-- Second statement inserts 4: 29 rows hold a non-NULL "sfwMessage", 24 of those are empty
-- strings or on a deleted user, and 1 of the remaining 5 contains HTML.
--
-- Banners containing HTML are SKIPPED, not stripped and not migrated as-is (Justin's call,
-- 2026-08-19). An announcement renders through CustomMarkdown with allowedElements ['a']
-- and no rehypeRaw, so markup that a profile banner renders today would land in the card as
-- literal escaped text. Those creators keep their existing blue banner, which still works
-- because this migration does not drop "UserProfile"."message".
--
-- The predicate deliberately over-matches: a false positive costs one creator an
-- announcement they still have a banner for, a false negative ships a broken card. It reads
-- an unterminated tag too (`<b `, `</p`), which is why it does not require a closing `>`.
-- On prod it selects 772 of 26,427; a tighter form requiring the `>` selects 770.
-- Do NOT reach for a backslash-b word boundary here. Postgres reads that escape as a backspace
-- character, so the pattern silently matches nothing, which looks exactly like a clean result.
-- Its word boundary is backslash-y; this pattern needs neither.
--
-- Nothing here notifies anyone: profileOnly rows are excluded from the feed and from the
-- notification fan-out by construction, and no spend is recorded for them.
--
-- Domain mapping preserves exactly what each banner shows today. `user-profile.service.ts`
-- uses sfwMessage on the green domain when it is non-null and falls back to message
-- otherwise, so:
--   * message, and no sfwMessage  -> shows everywhere            -> domain {all}
--   * message, with an sfwMessage -> shows everywhere but green  -> domain {blue,red}
--   * sfwMessage                  -> shows on green only         -> domain {green}
--
-- The branch tests NULL, not emptiness, because the live rule is `sfwMessage != null`.
-- 23 rows hold an empty-string sfwMessage (4 of them alongside a real message): today
-- green shows them nothing, so treating '' as absent would start publishing the
-- mature-domain text on green.
--
-- A banner has no title of its own, so these carry a generic one: 'Creator Announcement'.
-- Justin's call, 2026-08-19, after seeing a title-less card render. Stored rather than
-- applied at render so the row is complete on its own and a moderator reading the table
-- sees what a follower sees; a creator editing the announcement simply overwrites it.

INSERT INTO "Announcement" ("userId", "title", "content", "color", "domain", "startsAt", "profileOnly", "disabled", "metadata", "createdAt", "updatedAt")
SELECT
  p."userId",
  'Creator Announcement',
  p.message,
  'blue',
  CASE
    WHEN p."sfwMessage" IS NOT NULL THEN ARRAY['blue','red']::"DomainColor"[]
    ELSE ARRAY['all']::"DomainColor"[]
  END,
  p."messageAddedAt",
  true,
  false,
  '{"dismissible": true}'::jsonb,
  COALESCE(p."messageAddedAt", now()),
  now()
FROM "UserProfile" p
JOIN "User" u ON u.id = p."userId"
WHERE COALESCE(p.message, '') <> ''
  AND p.message !~* '</?[a-z][a-z0-9]*(\s|/|>)'
  AND u."deletedAt" IS NULL;

INSERT INTO "Announcement" ("userId", "title", "content", "color", "domain", "startsAt", "profileOnly", "disabled", "metadata", "createdAt", "updatedAt")
SELECT
  p."userId",
  'Creator Announcement',
  p."sfwMessage",
  'blue',
  ARRAY['green']::"DomainColor"[],
  p."sfwMessageAddedAt",
  true,
  false,
  '{"dismissible": true}'::jsonb,
  COALESCE(p."sfwMessageAddedAt", now()),
  now()
FROM "UserProfile" p
JOIN "User" u ON u.id = p."userId"
-- IS NOT NULL decides the DOMAIN SPLIT above, because that is what the live rule tests.
-- It must NOT decide whether a row is inserted: 23 profiles hold an empty-string
-- sfwMessage, and inserting those produces an announcement with no content — an empty
-- bordered card where green shows nothing today.
WHERE p."sfwMessage" IS NOT NULL
  AND p."sfwMessage" <> ''
  AND p."sfwMessage" !~* '</?[a-z][a-z0-9]*(\s|/|>)'
  AND u."deletedAt" IS NULL;

-- The columns are NOT dropped here. They stay until the carousel has been observed
-- working in production: ProfileHeader suppresses the banner once a creator has a live
-- announcement, so both can coexist safely, and keeping them means this migration is
-- reversible by deleting the rows it inserted rather than by restoring text nobody has.
--
-- To reverse:
--   DELETE FROM "Announcement" WHERE "profileOnly" = true AND title = 'Creator Announcement' AND "createdAt" < '<the date this ran>';
--
-- Follow-up, once the carousel is confirmed live:
--   ALTER TABLE "UserProfile"
--     DROP COLUMN "message", DROP COLUMN "messageAddedAt",
--     DROP COLUMN "sfwMessage", DROP COLUMN "sfwMessageAddedAt";
