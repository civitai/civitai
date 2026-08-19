-- Profile banner messages become profile-only announcements (CU 868ktjte1).
-- Applied by hand, like every migration here. Run AFTER 20260819000000_creator_announcements.
--
-- Counts at the time of writing (prod), for the runbook's before/after check:
-- 26,403 rows inserted by the first statement (non-empty "message", live user; 27,776
-- non-empty overall, 1,373 of them on deleted users), and 28 by the second (non-NULL
-- "sfwMessage": 5 with text, 23 empty-string).
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
-- title is deliberately empty: a banner has no title, and inventing one would put words
-- in 26,403 creators' mouths. The carousel renders the title only when non-empty.

INSERT INTO "Announcement" ("userId", "title", "content", "color", "domain", "startsAt", "profileOnly", "disabled", "metadata", "createdAt", "updatedAt")
SELECT
  p."userId",
  '',
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
  AND u."deletedAt" IS NULL;

INSERT INTO "Announcement" ("userId", "title", "content", "color", "domain", "startsAt", "profileOnly", "disabled", "metadata", "createdAt", "updatedAt")
SELECT
  p."userId",
  '',
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
WHERE p."sfwMessage" IS NOT NULL
  AND u."deletedAt" IS NULL;

-- The columns are NOT dropped here. They stay until the carousel has been observed
-- working in production: ProfileHeader suppresses the banner once a creator has a live
-- announcement, so both can coexist safely, and keeping them means this migration is
-- reversible by deleting the rows it inserted rather than by restoring text nobody has.
--
-- To reverse:
--   DELETE FROM "Announcement" WHERE "profileOnly" = true AND title = '' AND "createdAt" < '<the date this ran>';
--
-- Follow-up, once the carousel is confirmed live:
--   ALTER TABLE "UserProfile"
--     DROP COLUMN "message", DROP COLUMN "messageAddedAt",
--     DROP COLUMN "sfwMessage", DROP COLUMN "sfwMessageAddedAt";
