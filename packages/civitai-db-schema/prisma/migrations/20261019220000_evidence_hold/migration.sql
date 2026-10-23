-- Hold marker: while an owner has an active hold, none of their images is deleted.
--
-- Apply this BEFORE deploying the code that reads "EvidenceHeldUser": the purge jobs query the view
-- and fail on a database that lacks it.

CREATE TABLE "EvidenceHold" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "csamReportId" INTEGER,
  "role" TEXT NOT NULL,
  "reportSentAt" TIMESTAMP(3),
  "releaseAt" TIMESTAMP(3),
  "extendedUntil" TIMESTAMP(3),
  "extensionRequestedBy" TEXT,
  "extensionReference" TEXT,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" INTEGER,
  "releasedAt" TIMESTAMP(3),
  "releasedById" INTEGER,
  "releaseReason" TEXT,
  CONSTRAINT "EvidenceHold_role_check" CHECK ("role" IN ('subject', 'secondary', 'manual')),
  -- A report row names its report; a manual row names none.
  CONSTRAINT "EvidenceHold_report_role_check" CHECK (("role" = 'manual') = ("csamReportId" IS NULL)),
  -- A release is a logged act: who and why, never just a timestamp.
  CONSTRAINT "EvidenceHold_release_logged_check" CHECK (
    "releasedAt" IS NULL OR ("releasedById" IS NOT NULL AND btrim(COALESCE("releaseReason", '')) <> '')
  ),
  CONSTRAINT "EvidenceHold_release_whole_check" CHECK (
    "releasedAt" IS NOT NULL OR ("releasedById" IS NULL AND "releaseReason" IS NULL)
  ),
  -- An extension records who asked for it and their reference.
  CONSTRAINT "EvidenceHold_extension_logged_check" CHECK (
    "extendedUntil" IS NULL OR (
      btrim(COALESCE("extensionRequestedBy", '')) <> '' AND btrim(COALESCE("extensionReference", '')) <> ''
    )
  )
);

CREATE UNIQUE INDEX "EvidenceHold_csamReportId_userId_key"
  ON "EvidenceHold" ("csamReportId", "userId") WHERE "csamReportId" IS NOT NULL;
CREATE INDEX "EvidenceHold_userId_idx" ON "EvidenceHold" ("userId");

-- An image the delete trigger below kept, and the post it was in when it was kept: the trigger takes
-- it out of that post, and this row is the only record of where it was.
CREATE TABLE "EvidenceHoldImage" (
  "imageId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "postId" INTEGER,
  "keptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A held owner's post, copied as it was when it was deleted. The post itself is deleted as usual, so
-- nothing is left that could be published again; this row is what stands in for it.
CREATE TABLE "EvidenceHoldPost" (
  "postId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "title" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "modelVersionId" INTEGER,
  "collectionId" INTEGER,
  "metadata" JSONB,
  "keptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The one definition of "held". Every reader goes through this view.
CREATE VIEW "EvidenceHeldUser" AS
SELECT
  "userId",
  -- NULL: held until released.
  CASE WHEN bool_or("releaseAt" IS NULL) THEN NULL
       ELSE max(GREATEST("releaseAt", COALESCE("extendedUntil", "releaseAt"))) END AS "heldUntil"
FROM "EvidenceHold"
WHERE "releasedAt" IS NULL
  AND ("releaseAt" IS NULL OR "releaseAt" > now() OR "extendedUntil" > now())
GROUP BY "userId";

-- A sent report holds its subject and its secondary user for a year from sending. Written here rather
-- than at each call site, because several code paths set "reportSentAt". Never raises: a failure
-- here would fail the write that records a report as sent. The first send's row stands: a later
-- change to "reportSentAt" does not move "releaseAt".
CREATE OR REPLACE FUNCTION evidence_hold_from_csam_report() RETURNS trigger AS $$
BEGIN
  IF NEW."reportSentAt" IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO "EvidenceHold" ("userId", "csamReportId", "role", "reportSentAt", "releaseAt", "reason")
  SELECT v.uid, NEW."id", v.role, NEW."reportSentAt", NEW."reportSentAt" + interval '1 year', 'report sent'
  FROM (
    VALUES
      (NEW."userId", 'subject'),
      (CASE WHEN (NEW."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$'
            THEN (NEW."details" ->> 'secondaryUserId')::int END, 'secondary')
  ) AS v(uid, role)
  WHERE v.uid IS NOT NULL
  ON CONFLICT ("csamReportId", "userId") WHERE "csamReportId" IS NOT NULL DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "CsamReport_evidence_hold"
AFTER INSERT OR UPDATE OF "reportSentAt", "details" ON "CsamReport"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_from_csam_report();

-- Backstop for every deletion path, including ones written later: a held owner's image row is not
-- deleted. A direct DELETE skips the row (it is absent from RETURNING, so callers never go on to
-- delete its stored file) and removes the image the way a moderator block does, so a delete still
-- takes it off the site. It also leaves its post, so the owner does not see a deleted image come
-- back there; "EvidenceHoldImage" records which post. A delete reached from another trigger, which
-- includes a cascade from a parent row, raises instead: skipping a cascaded row would leave it
-- pointing at a deleted parent.
-- A row already blocked by a moderator ('moderated', 'tos', 'CSAM') keeps that block; any other row,
-- an owner-reversible 'AiNotVerified' block included, gets the moderated block.
-- The block's values are the app's own (`NsfwLevel.Blocked`, `BlockedReason.Moderated`), pinned by
-- remove-blocked-images-hold-guard.behavior.test.ts.
CREATE OR REPLACE FUNCTION evidence_hold_keep_image() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
    IF pg_trigger_depth() > 1 THEN
      RAISE EXCEPTION 'Image % cannot be deleted', OLD."id";
    END IF;
    -- The first record stands: a later delete finds the image already out of its post.
    INSERT INTO "EvidenceHoldImage" ("imageId", "userId", "postId")
    VALUES (OLD."id", OLD."userId", OLD."postId")
    ON CONFLICT ("imageId") DO NOTHING;
    UPDATE "Image"
    SET "ingestion" = 'Blocked', "nsfwLevel" = 32, "blockedFor" = 'moderated', "updatedAt" = now()
    WHERE "id" = OLD."id" AND NOT (
      "ingestion" = 'Blocked' AND COALESCE("blockedFor", '') IN ('moderated', 'tos', 'CSAM')
    );
    UPDATE "Image" SET "postId" = NULL, "updatedAt" = now()
    WHERE "id" = OLD."id" AND "postId" IS NOT NULL;
    -- Kept counts as moderated, so the account-deletion markers go even on a row already blocked:
    -- restoring the account would otherwise put the image back (account-deletion-image-markers.ts).
    UPDATE "Image"
    SET "metadata" = "metadata" - 'accountDeletionPriorIngestion' - 'accountDeletionPriorBlockedFor'
    WHERE "id" = OLD."id" AND ("metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "Image_evidence_hold"
BEFORE DELETE ON "Image"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_keep_image();

-- A held owner's models, images and posts keep their owner: the hold is keyed on it, so moving a row
-- to another account (a model transfer) would take it out of the hold.
CREATE OR REPLACE FUNCTION evidence_hold_keep_owner() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
    AND EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
    RAISE EXCEPTION '% % cannot change owner', TG_TABLE_NAME, OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "Image_evidence_hold_owner"
BEFORE UPDATE OF "userId" ON "Image"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_keep_owner();

CREATE TRIGGER "Post_evidence_hold_owner"
BEFORE UPDATE OF "userId" ON "Post"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_keep_owner();

CREATE TRIGGER "Model_evidence_hold_owner"
BEFORE UPDATE OF "userId" ON "Model"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_keep_owner();

-- A hold only ends by date or by a recorded release, and its row is a record that stays: it is never
-- deleted and a released row never changes. While unreleased, only its end and its extension change,
-- and the end only stays or moves later; an extension is never cleared, and its who and reference
-- change only with a changed "extendedUntil".
-- A release sets only the release columns, stamped now.
CREATE OR REPLACE FUNCTION evidence_hold_guard_end() RETURNS trigger AS $$
DECLARE
  -- A NULL "releaseAt" holds until released, so it is the latest end there is.
  old_end timestamp := CASE WHEN OLD."releaseAt" IS NULL THEN 'infinity'::timestamp
    ELSE GREATEST(OLD."releaseAt", COALESCE(OLD."extendedUntil", OLD."releaseAt")) END;
  new_end timestamp;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EvidenceHold % cannot be deleted', OLD."id";
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'EvidenceHold % is released and cannot change', OLD."id";
  END IF;
  IF (NEW."id", NEW."userId", NEW."csamReportId", NEW."role", NEW."reportSentAt", NEW."reason",
      NEW."createdAt", NEW."createdById")
    IS DISTINCT FROM (OLD."id", OLD."userId", OLD."csamReportId", OLD."role", OLD."reportSentAt",
      OLD."reason", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'EvidenceHold % cannot change its owner or source', OLD."id";
  END IF;
  IF NEW."releasedAt" IS NOT NULL THEN
    IF (NEW."releaseAt", NEW."extendedUntil", NEW."extensionRequestedBy", NEW."extensionReference")
      IS DISTINCT FROM (OLD."releaseAt", OLD."extendedUntil", OLD."extensionRequestedBy",
        OLD."extensionReference") THEN
      RAISE EXCEPTION 'EvidenceHold % cannot change its dates in a release', OLD."id";
    END IF;
    NEW."releasedAt" := now();
    RETURN NEW;
  END IF;
  IF NEW."releasedById" IS NOT NULL OR NEW."releaseReason" IS NOT NULL THEN
    RAISE EXCEPTION 'EvidenceHold % is released only with "releasedAt"', OLD."id";
  END IF;
  IF OLD."extendedUntil" IS NOT NULL AND NEW."extendedUntil" IS NULL THEN
    RAISE EXCEPTION 'EvidenceHold % cannot clear its extension', OLD."id";
  END IF;
  IF NEW."extendedUntil" IS NOT DISTINCT FROM OLD."extendedUntil"
    AND (NEW."extensionRequestedBy", NEW."extensionReference")
      IS DISTINCT FROM (OLD."extensionRequestedBy", OLD."extensionReference") THEN
    RAISE EXCEPTION 'EvidenceHold % changes who asked for an extension only with a new one', OLD."id";
  END IF;
  new_end := CASE WHEN NEW."releaseAt" IS NULL THEN 'infinity'::timestamp
    ELSE GREATEST(NEW."releaseAt", COALESCE(NEW."extendedUntil", NEW."releaseAt")) END;
  IF new_end < old_end THEN
    RAISE EXCEPTION 'EvidenceHold % can only end by a recorded release', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "EvidenceHold_guard_end"
BEFORE UPDATE OR DELETE ON "EvidenceHold"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_guard_end();

-- What a hold kept is never edited, and leaves only once its owner is no longer held
-- (evidence_hold_purge_unheld).
CREATE OR REPLACE FUNCTION evidence_hold_guard_kept() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% % cannot change', TG_TABLE_NAME, OLD."userId";
  END IF;
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
    RAISE EXCEPTION '% row cannot be deleted while its owner is held', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "EvidenceHoldImage_guard"
BEFORE UPDATE OR DELETE ON "EvidenceHoldImage"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_guard_kept();

CREATE TRIGGER "EvidenceHoldPost_guard"
BEFORE UPDATE OR DELETE ON "EvidenceHoldPost"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_guard_kept();

-- TRUNCATE skips row triggers, so it is refused outright on all three tables.
CREATE OR REPLACE FUNCTION evidence_hold_refuse_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "EvidenceHold_refuse_truncate"
BEFORE TRUNCATE ON "EvidenceHold"
FOR EACH STATEMENT EXECUTE FUNCTION evidence_hold_refuse_truncate();

CREATE TRIGGER "EvidenceHoldImage_refuse_truncate"
BEFORE TRUNCATE ON "EvidenceHoldImage"
FOR EACH STATEMENT EXECUTE FUNCTION evidence_hold_refuse_truncate();

CREATE TRIGGER "EvidenceHoldPost_refuse_truncate"
BEFORE TRUNCATE ON "EvidenceHoldPost"
FOR EACH STATEMENT EXECUTE FUNCTION evidence_hold_refuse_truncate();

-- Every deletion path of a held owner's post, the owner's own included, copies it first. The delete
-- itself goes ahead.
CREATE OR REPLACE FUNCTION evidence_hold_keep_post() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
    INSERT INTO "EvidenceHoldPost" (
      "postId", "userId", "title", "detail", "createdAt", "publishedAt", "modelVersionId",
      "collectionId", "metadata"
    )
    VALUES (
      OLD."id", OLD."userId", OLD."title", OLD."detail", OLD."createdAt", OLD."publishedAt",
      OLD."modelVersionId", OLD."collectionId", OLD."metadata"
    )
    ON CONFLICT ("postId") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "Post_evidence_hold"
BEFORE DELETE ON "Post"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_keep_post();

-- What a hold kept is kept only while the hold lasts. A release purges its owner's rows at once; a
-- hold that ends by its date is swept by remove-blocked-images, which calls this with no owner.
CREATE OR REPLACE FUNCTION evidence_hold_purge_unheld(target_user INTEGER DEFAULT NULL) RETURNS void AS $$
  DELETE FROM "EvidenceHoldPost" p
  WHERE (target_user IS NULL OR p."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = p."userId");
  DELETE FROM "EvidenceHoldImage" i
  WHERE (target_user IS NULL OR i."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = i."userId");
$$ LANGUAGE sql SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION evidence_hold_purge_on_release() RETURNS trigger AS $$
BEGIN
  PERFORM evidence_hold_purge_unheld(OLD."userId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "EvidenceHold_purge_on_release"
AFTER UPDATE ON "EvidenceHold"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_purge_on_release();

-- Existing sent reports. One whose year has already passed is recorded as released by the system
-- user, never put back on hold; that set is the rows with this "releaseReason".
-- A report whose id the applier has put in this session's evidence_hold_backfill_keep is inserted
-- unreleased instead, so a hold extended in the same transaction never passes through a release,
-- which the end guard makes final. The list can only keep a row from being released, never release one.
CREATE TEMP TABLE IF NOT EXISTS evidence_hold_backfill_keep (report_id INTEGER PRIMARY KEY);

INSERT INTO "EvidenceHold" (
  "userId", "csamReportId", "role", "reportSentAt", "releaseAt", "reason",
  "releasedAt", "releasedById", "releaseReason"
)
SELECT
  v.uid, c."id", v.role, c."reportSentAt", c."reportSentAt" + interval '1 year', 'report sent',
  r."releasedAt", r."releasedById", r."releaseReason"
FROM "CsamReport" c
CROSS JOIN LATERAL (
  SELECT c."reportSentAt" + interval '1 year' <= now()
    AND NOT EXISTS (
      SELECT 1 FROM pg_temp.evidence_hold_backfill_keep k WHERE k.report_id = c."id"
    ) AS released
) e
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN e.released THEN now() END AS "releasedAt",
    CASE WHEN e.released THEN -1 END AS "releasedById",
    CASE WHEN e.released THEN 'expired before table existed' END AS "releaseReason"
) r
CROSS JOIN LATERAL (
  VALUES
    (c."userId", 'subject'),
    (CASE WHEN (c."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$'
          THEN (c."details" ->> 'secondaryUserId')::int END, 'secondary')
) AS v(uid, role)
WHERE c."reportSentAt" IS NOT NULL AND v.uid IS NOT NULL
ON CONFLICT ("csamReportId", "userId") WHERE "csamReportId" IS NOT NULL DO NOTHING;

DROP TABLE pg_temp.evidence_hold_backfill_keep;
