-- Catch-up: legacy profile banners that still show become profile-only announcements.
--
-- 🔴 APPLIED BY HAND, ONCE, BY THE RELEASE OWNER, after profile-redesign opens to everyone. It is not a
-- Prisma migration and lives outside prisma/migrations so nothing applies it with them:
--   psql -v ON_ERROR_STOP=1 -f profile-banner-catchup.sql
--
-- Why it exists: 20260819010000_migrate_profile_banners_to_announcements is a one-shot whose
-- marker gate makes a re-run insert nothing (its header says so). Banners written or changed
-- since, and banners on profiles that no longer have a live announcement, still render as the
-- old blue banner. This file converts exactly those, with the August file's columns, title,
-- color, flags, createdAt handling, HTML skip, deleted-user skip, advisory lock and gate.
--
-- ============================================================================
-- THE LIVE RULE, TRANSLATED. Keep these in step with the code they cite.
-- ============================================================================
-- A banner shows on a profile iff (profile.utils.ts:164-172, shouldShowProfileMessage, called
-- at ProfileHeader.tsx:104-112):
--   * the domain's banner text is truthy: on green, sfwMessage when it IS NOT NULL, else
--     message; on every other domain, message (user-profile.service.ts:189,254). '' is falsy;
--   * the author is not muted: the "User"."muted" column itself (user.selector.ts:73, and
--     hot-reads-9.reads.ts:141 on the Kysely path), with no expiry logic applied;
--   * the creator has no announcement returned by getCreatorAnnouncements
--     (creator-announcement.service.ts:178-189): any row with this userId, profileOnly or
--     not, that is live per activeAnnouncementWhere (announcement-window.ts:17-27,35-37:
--     disabled = false, startsAt <= now or NULL, endsAt >= now or NULL), and whose domain
--     overlaps {all, <request domain>} (hasSome, i.e. &&).
--
-- The request domain is only ever green or blue: the red host is configured as blue too and
-- getRequestDomainColor is a first-match walk, so it resolves blue (server-domain.ts:174-178,
-- 213-222). A {red}-only announcement therefore never hides a banner, and the checks below
-- test {all,blue} and {all,green}, never red. Stored domains map back to read domains as:
-- shows on blue -> {blue,red}; on green -> {green}; on both -> {all}.
--
-- Not expressible here, so assumed: the creatorAnnouncements flag is on for every viewer (with
-- it off the hook never queries and announcementCount is 0, creator-announcements.utils.ts:
-- 16-27); and the blocked-viewer branch (creator-announcement.service.ts:171-176) is
-- per-viewer, though it hides the banner as well, so it changes no row here.
--
-- ============================================================================
-- DOMAIN SPLIT, as August
-- ============================================================================
--   * message, sfwMessage NULL     -> the domains among {blue, green} where it still shows
--   * message, sfwMessage NOT NULL -> {blue,red}, if it still shows on blue
--   * non-empty sfwMessage         -> {green}, if it still shows on green
-- NULL, not emptiness, picks the branch, as in August; '' sfwMessage hides green's banner.
--
-- ============================================================================
-- PENDING DECISIONS (product owner). Neither is decided; this file does not settle them.
-- ============================================================================
-- 1. Creators who DELETED their August announcement now show their banner again, so this file
--    recreates it for them; the same holds for one past its endsAt. Pending: whether those are
--    recreated or excluded; nothing here records who deleted what. A creator with ANY announcement
--    a moderator disabled (creators cannot set "disabled", creator-announcement.service.ts:
--    631-633) is excluded outright: a catch-up must not route around a moderation action.
-- 2. The 772 HTML banners (August count) stay SKIPPED, by the same predicate. Pending.
-- Dropping the UserProfile message columns (tracked privately) waits for both decisions.
--
-- HTML predicate, copied from August with its warnings: it over-matches on purpose, and do NOT
-- use a backslash-b word boundary (Postgres reads it as a backspace, so the pattern silently
-- matches nothing). Run with standard_conforming_strings on (the default): off, the
-- backslash-s degrades to a literal s and `<b class=...` stops matching.
--
-- Timestamps: the Announcement columns are timestamp without time zone holding UTC, compared
-- with now(); the file sets TimeZone UTC for its transaction, and the queries below need it.
--
-- ============================================================================
-- DRY RUN (before). Same predicates as the statements; record both counts.
-- ============================================================================
--   BEGIN; SET LOCAL TimeZone = 'UTC';
--   -- statement 1
--   SELECT count(*) FROM (
--     SELECT NOT EXISTS (SELECT 1 FROM "Announcement" a WHERE a."userId" = p."userId"
--              AND NOT a.disabled AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
--              AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
--              AND a.domain && ARRAY['all','blue']::"DomainColor"[]) AS on_blue,
--            p."sfwMessage" IS NULL
--            AND NOT EXISTS (SELECT 1 FROM "Announcement" a WHERE a."userId" = p."userId"
--              AND NOT a.disabled AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
--              AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
--              AND a.domain && ARRAY['all','green']::"DomainColor"[]) AS on_green
--     FROM "UserProfile" p JOIN "User" u ON u.id = p."userId"
--     WHERE COALESCE(p.message, '') <> '' AND p.message !~* '</?[a-z][a-z0-9]*(\s|/|>)'
--       AND u."deletedAt" IS NULL AND NOT u.muted
--       AND NOT EXISTS (SELECT 1 FROM "Announcement" m WHERE m."userId" = p."userId" AND m.disabled)
--   ) c WHERE c.on_blue OR c.on_green;
--   -- statement 2
--   SELECT count(*) FROM "UserProfile" p JOIN "User" u ON u.id = p."userId"
--   WHERE p."sfwMessage" IS NOT NULL AND p."sfwMessage" <> ''
--     AND p."sfwMessage" !~* '</?[a-z][a-z0-9]*(\s|/|>)'
--     AND u."deletedAt" IS NULL AND NOT u.muted
--     AND NOT EXISTS (SELECT 1 FROM "Announcement" m WHERE m."userId" = p."userId" AND m.disabled)
--     AND NOT EXISTS (SELECT 1 FROM "Announcement" a WHERE a."userId" = p."userId"
--       AND NOT a.disabled AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
--       AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
--       AND a.domain && ARRAY['all','green']::"DomainColor"[]);
--   ROLLBACK;
--
-- ============================================================================
-- READ-BACK (right after COMMIT)
-- ============================================================================
-- a) Inserted counts within a few rows of the dry run (banners drift; exact is not expected):
--   SELECT metadata->>'migrated', count(*) FROM "Announcement"
--   WHERE metadata->>'migrated' IN ('message-catchup', 'sfwMessage-catchup') GROUP BY 1;
-- b) No user has two catch-up rows on one read domain. Expect zero rows:
--   SELECT a."userId", d, count(*) FROM "Announcement" a
--   CROSS JOIN unnest(ARRAY['blue','green']::"DomainColor"[]) d
--   WHERE a.metadata->>'migrated' IN ('message-catchup', 'sfwMessage-catchup')
--     AND a.domain && ARRAY['all', d]::"DomainColor"[]
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- c) The live rule finds no profile still showing a non-HTML banner. Expect zero rows:
--   BEGIN; SET LOCAL TimeZone = 'UTC';
--   SELECT d, count(*) FROM "UserProfile" p JOIN "User" u ON u.id = p."userId"
--   CROSS JOIN unnest(ARRAY['blue','green']::"DomainColor"[]) d
--   CROSS JOIN LATERAL (SELECT CASE WHEN d = 'green' AND p."sfwMessage" IS NOT NULL
--                              THEN p."sfwMessage" ELSE p.message END AS banner) b
--   WHERE COALESCE(b.banner, '') <> '' AND b.banner !~* '</?[a-z][a-z0-9]*(\s|/|>)'
--     AND u."deletedAt" IS NULL AND NOT u.muted
--     AND NOT EXISTS (SELECT 1 FROM "Announcement" m WHERE m."userId" = p."userId" AND m.disabled)
--     AND NOT EXISTS (SELECT 1 FROM "Announcement" a WHERE a."userId" = p."userId"
--       AND NOT a.disabled AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
--       AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
--       AND a.domain && ARRAY['all', d]::"DomainColor"[])
--   GROUP BY d;
--   ROLLBACK;
--
-- Re-running is safe and inserts nothing: each statement is gated on its own marker, as in
-- August, and the marker is dropped when a creator edits the row (so the reverse misses
-- adopted rows). Nothing notifies: profileOnly rows never enter the feed or the fan-out.

BEGIN;

-- Same lock and lock_timeout handling as August; see that file for why each line is here.
SET LOCAL lock_timeout = 0;
SELECT pg_advisory_xact_lock(1095630849::int, 0::int);
SET LOCAL lock_timeout = '5s';
SET LOCAL TimeZone = 'UTC';

-- 1. message
INSERT INTO "Announcement" ("userId", "title", "content", "color", "domain", "startsAt", "profileOnly", "disabled", "metadata", "createdAt", "updatedAt")
SELECT
  c."userId",
  'Creator Announcement',
  c.message,
  'blue',
  CASE
    WHEN c.on_blue AND c.on_green THEN ARRAY['all']::"DomainColor"[]
    WHEN c.on_blue THEN ARRAY['blue','red']::"DomainColor"[]
    ELSE ARRAY['green']::"DomainColor"[]
  END,
  c."messageAddedAt",
  true,
  false,
  '{"dismissible": true, "migrated": "message-catchup"}'::jsonb,
  COALESCE(c."messageAddedAt", now()),
  now()
FROM (
  SELECT
    p."userId",
    p.message,
    p."messageAddedAt",
    NOT EXISTS (
      SELECT 1 FROM "Announcement" a
      WHERE a."userId" = p."userId"
        AND NOT a.disabled
        AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
        AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
        AND a.domain && ARRAY['all','blue']::"DomainColor"[]
    ) AS on_blue,
    -- With an sfwMessage, green shows that instead (statement 2), whatever it holds.
    p."sfwMessage" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "Announcement" a
      WHERE a."userId" = p."userId"
        AND NOT a.disabled
        AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
        AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
        AND a.domain && ARRAY['all','green']::"DomainColor"[]
    ) AS on_green
  FROM "UserProfile" p
  JOIN "User" u ON u.id = p."userId"
  WHERE COALESCE(p.message, '') <> ''
    AND p.message !~* '</?[a-z][a-z0-9]*(\s|/|>)'
    AND u."deletedAt" IS NULL
    AND NOT u.muted
    AND NOT EXISTS (
      SELECT 1 FROM "Announcement" m WHERE m."userId" = p."userId" AND m.disabled
    )
) c
WHERE (c.on_blue OR c.on_green)
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" a WHERE a.metadata->>'migrated' = 'message-catchup'
  );

-- 2. sfwMessage. Statement 1's rows for these profiles are {blue,red} and cannot hide it.
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
  '{"dismissible": true, "migrated": "sfwMessage-catchup"}'::jsonb,
  COALESCE(p."sfwMessageAddedAt", now()),
  now()
FROM "UserProfile" p
JOIN "User" u ON u.id = p."userId"
WHERE p."sfwMessage" IS NOT NULL
  AND p."sfwMessage" <> ''
  AND p."sfwMessage" !~* '</?[a-z][a-z0-9]*(\s|/|>)'
  AND u."deletedAt" IS NULL
  AND NOT u.muted
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" m WHERE m."userId" = p."userId" AND m.disabled
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" a
    WHERE a."userId" = p."userId"
      AND NOT a.disabled
      AND (a."startsAt" <= now() OR a."startsAt" IS NULL)
      AND (a."endsAt" >= now() OR a."endsAt" IS NULL)
      AND a.domain && ARRAY['all','green']::"DomainColor"[]
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" a WHERE a.metadata->>'migrated' = 'sfwMessage-catchup'
  );

COMMIT;

-- To reverse:
--   DELETE FROM "Announcement" WHERE metadata->>'migrated' IN ('message-catchup', 'sfwMessage-catchup');
-- The marker makes this exact; a createdAt window is not (rows take messageAddedAt).
