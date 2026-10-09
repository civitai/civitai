-- Scored event cosmetics: where each event cosmetic instance was placed, and for how long.
--
-- An event cosmetic is a ContentDecoration whose `data` carries both `event` and `team`. While one
-- sits on a piece of content, that content's impressions and reactions score for the cosmetic's
-- team. "UserCosmetic"."equippedAt" only records the CURRENT placement, so every placement change is
-- logged here as an interval by a trigger on "UserCosmetic". A trigger rather than app code because
-- placements change through several writers (equip, unequip, revoke, end-of-event cleanup, raw SQL
-- in other apps), and a ledger that one of them can skip is not a ledger.
--
-- Apply order: this file (any time before the deploy; it is inert until a Cosmetic row has
-- data.event and data.team), then the ClickHouse table `event_cosmetic_placements`, then the deploy.
--
-- 🔴 CREATE OR REPLACE TRIGGER takes a SHARE ROW EXCLUSIVE lock on "UserCosmetic" (blocks writes, not
-- reads). Do not add a DROP TRIGGER: that takes ACCESS EXCLUSIVE, which queues every read of the table
-- too, even when there is no trigger to drop. Each trigger statement sets a lock_timeout so a
-- long-running reader makes it fail fast instead of queueing writes behind it; re-run on timeout.
-- Apply one statement at a time and read each result.

CREATE TABLE IF NOT EXISTS "EventCosmeticPlacement" (
  "id"            BIGSERIAL PRIMARY KEY,
  "event"         TEXT NOT NULL,
  "userId"        INTEGER NOT NULL,
  "cosmeticId"    INTEGER NOT NULL,
  "claimKey"      TEXT NOT NULL,
  "team"          TEXT NOT NULL,
  "entityType"    "CosmeticEntity" NOT NULL,
  "entityId"      INTEGER NOT NULL,
  -- Owner of the content at placement time. Scoring only counts placements on the cosmetic owner's
  -- own content, so this is checked again at query time rather than trusted from the equip path.
  "entityOwnerId" INTEGER,
  "startedAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "endedAt"       TIMESTAMPTZ(3),
  "updatedAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- One open interval per cosmetic instance.
CREATE UNIQUE INDEX IF NOT EXISTS "EventCosmeticPlacement_open_key"
  ON "EventCosmeticPlacement" ("userId", "cosmeticId", "claimKey")
  WHERE "endedAt" IS NULL;

-- The scoring job mirrors rows changed since its last run.
CREATE INDEX IF NOT EXISTS "EventCosmeticPlacement_event_updatedAt_idx"
  ON "EventCosmeticPlacement" ("event", "updatedAt");

CREATE TABLE IF NOT EXISTS "EventCosmeticScoreDaily" (
  "event"           TEXT NOT NULL,
  "day"             DATE NOT NULL,
  "userId"          INTEGER NOT NULL,
  "cosmeticId"      INTEGER NOT NULL,
  "claimKey"        TEXT NOT NULL,
  "team"            TEXT NOT NULL,
  "impressions"     INTEGER NOT NULL DEFAULT 0,
  "anonImpressions" INTEGER NOT NULL DEFAULT 0,
  "reactions"       INTEGER NOT NULL DEFAULT 0,
  "points"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("event", "userId", "cosmeticId", "claimKey", "day")
);

CREATE INDEX IF NOT EXISTS "EventCosmeticScoreDaily_event_day_idx"
  ON "EventCosmeticScoreDaily" ("event", "day");

CREATE OR REPLACE FUNCTION event_cosmetic_placement_log() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  c_event TEXT;
  c_team  TEXT;
  owner   INTEGER;
BEGIN
  -- Close the interval for where the cosmetic was. A non-event cosmetic has no open interval, so this
  -- is one probe of the partial unique index and changes nothing.
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."equippedToId" IS NOT NULL THEN
    UPDATE "EventCosmeticPlacement"
    SET "endedAt" = now(), "updatedAt" = now()
    WHERE "userId" = OLD."userId"
      AND "cosmeticId" = OLD."cosmeticId"
      AND "claimKey" = OLD."claimKey"
      AND "endedAt" IS NULL;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW."equippedToId" IS NOT NULL
     AND NEW."equippedToType" IS NOT NULL THEN
    SELECT c.data->>'event', c.data->>'team'
    INTO c_event, c_team
    FROM "Cosmetic" c
    WHERE c.id = NEW."cosmeticId"
      AND c.type = 'ContentDecoration';

    IF c_event IS NOT NULL AND c_team IS NOT NULL THEN
      owner := CASE NEW."equippedToType"
        WHEN 'Image' THEN (SELECT "userId" FROM "Image" WHERE id = NEW."equippedToId")
        WHEN 'Model' THEN (SELECT "userId" FROM "Model" WHERE id = NEW."equippedToId")
        WHEN 'Article' THEN (SELECT "userId" FROM "Article" WHERE id = NEW."equippedToId")
        ELSE NULL
      END;

      -- Self-healing: if an interval for this instance is somehow still open, close it rather than
      -- let the unique index fail the user's equip.
      UPDATE "EventCosmeticPlacement"
      SET "endedAt" = now(), "updatedAt" = now()
      WHERE "userId" = NEW."userId"
        AND "cosmeticId" = NEW."cosmeticId"
        AND "claimKey" = NEW."claimKey"
        AND "endedAt" IS NULL;

      INSERT INTO "EventCosmeticPlacement"
        ("event", "userId", "cosmeticId", "claimKey", "team", "entityType", "entityId", "entityOwnerId")
      VALUES
        (c_event, NEW."userId", NEW."cosmeticId", NEW."claimKey", c_team,
         NEW."equippedToType", NEW."equippedToId", owner);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- The WHEN clauses keep the function off the hot paths: a bulk grant inserts rows with no placement
-- (equippedToId NULL) and an equip-timestamp bump leaves the placement columns unchanged, so neither
-- calls the function at all.
DO $$
BEGIN
  SET LOCAL lock_timeout = '2s';
  CREATE OR REPLACE TRIGGER event_cosmetic_placement_insert
    AFTER INSERT ON "UserCosmetic"
    FOR EACH ROW
    WHEN (NEW."equippedToId" IS NOT NULL)
    EXECUTE FUNCTION event_cosmetic_placement_log();
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '2s';
  CREATE OR REPLACE TRIGGER event_cosmetic_placement_update
    AFTER UPDATE OF "equippedToId", "equippedToType", "userId", "cosmeticId", "claimKey" ON "UserCosmetic"
    FOR EACH ROW
    WHEN (
      OLD."equippedToId" IS DISTINCT FROM NEW."equippedToId"
      OR OLD."equippedToType" IS DISTINCT FROM NEW."equippedToType"
      OR (
        NEW."equippedToId" IS NOT NULL
        AND (OLD."userId", OLD."cosmeticId", OLD."claimKey")
          IS DISTINCT FROM (NEW."userId", NEW."cosmeticId", NEW."claimKey")
      )
    )
    EXECUTE FUNCTION event_cosmetic_placement_log();
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '2s';
  CREATE OR REPLACE TRIGGER event_cosmetic_placement_delete
    AFTER DELETE ON "UserCosmetic"
    FOR EACH ROW
    WHEN (OLD."equippedToId" IS NOT NULL)
    EXECUTE FUNCTION event_cosmetic_placement_log();
END $$;
