-- Profile banner messages become profile-only announcements (CU 868ktjte1).
-- Applied by hand, like every migration here. Run AFTER 20260819000000_creator_announcements,
-- with ON_ERROR_STOP, as that file's header instructs:
--   psql -v ON_ERROR_STOP=1 -f migration.sql
--
-- 🔴 THIS FILE IS A ONE-SHOT, NOT A SYNC. Re-running it is safe and inserts nothing. It does
-- NOT "resume" in the sense the sibling migration's header uses for its own DDL: the gate
-- asks "did this statement ever run", not "which rows are missing". So a second run a week
-- later, to pick up banners written since, inserts 0 and prints INSERT 0 0 with no signal
-- that anything was skipped. Catching those up is a hand-written statement, not a re-run.
--
-- Unguarded it would have been worse in the other direction: two statements with a re-run
-- inserting 25,655 duplicates, every affected creator seeing the same card twice. Each
-- statement is gated on its own marker in metadata rather than on the rows it would write,
-- because a marker no creator can author is the only discriminator that survives creators
-- authoring their own profileOnly announcements. Matching row-for-row on content instead is
-- both slower (a correlated scan per profile, which times out on prod-sized data) and wrong
-- once someone edits a migrated announcement.
--
-- 🔴 ONE SESSION AT A TIME, and the advisory lock below is what enforces it. The gate is an
-- InitPlan evaluated against the snapshot taken at statement start, so two psql sessions that
-- both begin before either commits would both see no marker and both insert the full set —
-- and no unique constraint exists to catch it. Statement 1 is 25k inserts and takes a while;
-- an operator who reads "re-running is safe" and decides the session is wedged is exactly how
-- the second session gets opened. The lock makes that second session wait instead, after
-- which its gate sees the marker and it inserts nothing. Do not remove it, and do not split
-- the file back out of its transaction.
--
-- No creator path can write or preserve this marker: upsertCreatorAnnouncementSchema takes no
-- metadata field at all, and creator-announcement.service.ts rebuilds metadata from scratch
-- and writes it wholesale. So nothing hand-authored is ever caught by the gate or the reverse
-- below. Equally, the marker is dropped the first time a creator edits their announcement.
-- That is fine for a gate that only has to hold during the run, but it does mean the reverse
-- misses rows a creator has already adopted.
--
-- Counts (prod, 2026-08-19), for the runbook's before/after check:
-- First statement inserts 25,655: 27,806 rows hold a non-empty "message", 1,379 of those
-- sit on deleted users, leaving 26,427 live, and 772 of those contain HTML and are skipped.
-- Second statement inserts 4: 29 rows hold a non-NULL "sfwMessage", 24 of those are empty
-- strings or on a deleted user, and 1 of the remaining 5 contains HTML.
--
-- These are a snapshot, not a target: creators keep editing their banners, so the first
-- number drifts upward (it had already moved to 25,657 within the afternoon). Check the
-- result for the right order of magnitude and a single-digit second statement — an exact
-- match is not expected and a mismatch on its own is not a fault.
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
-- Its word boundary is backslash-y; this pattern needs neither. Do check that the session has
-- standard_conforming_strings on, which is the default: with it off the backslash-s in the
-- pattern degrades to a literal s, and the predicate quietly stops matching `<b class=...`
-- while still matching `<div>`.
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

BEGIN;

-- 1095630849 is ANNOUNCEMENT_LOCK_CLASS (0x414e0001) from creator-announcement.service.ts,
-- written in decimal because hex integer literals need Postgres 16. The app locks
-- (class, userId) with a real user id, so (class, 0) cannot collide with a creator saving.
--
-- Keep the TWO-argument form. The one-argument form is a different keyspace entirely, and
-- article.service.ts already locks in it on bare article ids — a one-arg lock here would
-- collide with whichever article shares this number.
SELECT pg_advisory_xact_lock(1095630849::int, 0::int);

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
  '{"dismissible": true, "migrated": "message"}'::jsonb,
  COALESCE(p."messageAddedAt", now()),
  now()
FROM "UserProfile" p
JOIN "User" u ON u.id = p."userId"
WHERE COALESCE(p.message, '') <> ''
  AND p.message !~* '</?[a-z][a-z0-9]*(\s|/|>)'
  AND u."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" a WHERE a.metadata->>'migrated' = 'message'
  );

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
  '{"dismissible": true, "migrated": "sfwMessage"}'::jsonb,
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
  AND u."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Announcement" a WHERE a.metadata->>'migrated' = 'sfwMessage'
  );

COMMIT;

-- The columns are NOT dropped here. They stay until the carousel has been observed
-- working in production: ProfileHeader suppresses the banner once a creator has a live
-- announcement, so both can coexist safely, and keeping them means this migration is
-- reversible by deleting the rows it inserted rather than by restoring text nobody has.
--
-- To reverse:
--   DELETE FROM "Announcement" WHERE metadata->>'migrated' IN ('message', 'sfwMessage');
-- The marker is what makes this exact. A timestamp window is not: 8 of the inserted rows have
-- a NULL "messageAddedAt" and so take createdAt = now(), which a bare date (midnight) sorts
-- before, leaving those creators an orphaned card the reverse reported as removed.
--
-- Follow-up, once the carousel is confirmed live:
--   ALTER TABLE "UserProfile"
--     DROP COLUMN "message", DROP COLUMN "messageAddedAt",
--     DROP COLUMN "sfwMessage", DROP COLUMN "sfwMessageAddedAt";
