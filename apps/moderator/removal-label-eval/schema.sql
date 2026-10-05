-- Removal-label pilot: blind relabel set and eval predictions. MODERATOR database (internal_tools).
--
-- Applied BY HAND, like xguard-lab/schema.sql. Then `pnpm run db:moderator:pull` and
-- `pnpm run db:moderator:generate` to confirm the hand-written models in schema.prisma match.
-- Idempotent, so re-running it is harmless.
--
-- No foreign keys into the Civitai database: image and user ids are plain values.

CREATE TABLE IF NOT EXISTS relabel_item (
  id              bigserial PRIMARY KEY,
  -- What the page shows in place of the serial id: ids grow batch by batch, and with the purge
  -- window an old id would say which stratum an item is in.
  token           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  batch           text NOT NULL,
  image_id        integer NOT NULL,
  stratum         text NOT NULL CHECK (stratum IN ('removed', 'not_removed')),
  -- The moderator's removal reason. Null for not-removed items.
  bucket          text CHECK (bucket IN ('animatedMinorNsfw', 'realisticMinorNsfw', 'schoolNsfw', 'realisticMinor')),
  -- NSFW level before removal (removed) or now (not removed): None/Soft/Mature/X/Blocked.
  nsfw_level      text,
  -- Sampling stratum within the batch, so a report can re-weight to the true mix.
  stratum_key     text NOT NULL,
  -- Split group: one uploader's images never sit on both sides of an eval split.
  owner_id        integer NOT NULL,
  removed_at      timestamptz,
  removed_by      integer,
  -- When remove-blocked-images will hard-delete it. Null for not-removed items.
  purge_after     timestamptz,
  appeal_status   text,
  appeal_resolved_at timestamptz,
  -- False for items only the model arms run on. The full-population disagreement and appeal
  -- numbers need every removal, which is far more than two labelers can answer.
  relabel         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One row per image across all batches: daily batches overlap, and a repeat would show the
  -- labeler the same image twice and count it twice in the report.
  UNIQUE (image_id),
  CHECK ((stratum = 'removed') = (bucket IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS relabel_item_batch_idx ON relabel_item (batch);

-- One labeler's answers for one item. Labelers never see each other's rows.
CREATE TABLE IF NOT EXISTS relabel_answer (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES relabel_item(id) ON DELETE CASCADE,
  labeler_id      integer NOT NULL,
  minor_present   text NOT NULL CHECK (minor_present IN ('clearly_adult', 'ambiguous_could_be_minor', 'appears_minor', 'no_person_or_character', 'cannot_tell')),
  sexual_level    text NOT NULL CHECK (sexual_level IN ('none', 'suggestive_clothed', 'partial_nudity', 'explicit_nudity', 'sexual_act', 'cannot_tell')),
  violence        text NOT NULL CHECK (violence IN ('none', 'weapon_present_no_threat', 'threat_or_aiming', 'injury_or_blood', 'graphic_gore', 'cannot_tell')),
  school_setting  text NOT NULL CHECK (school_setting IN ('school_classroom_or_campus', 'school_uniform_only_no_school_setting', 'other_setting', 'cannot_tell')),
  -- Time on item. A labeler averaging two seconds is rubber-stamping.
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, labeler_id)
);

-- Exactly two labelers per item is the design (their agreement is the human baseline). A third
-- would silently turn a pair into a vote. Enforced here rather than in the page, because two
-- labelers claiming the last slot at once both pass an application-side count.
CREATE OR REPLACE FUNCTION relabel_answer_max_two() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM relabel_item WHERE id = NEW.item_id FOR UPDATE;
  IF (SELECT count(*) FROM relabel_answer WHERE item_id = NEW.item_id AND labeler_id <> NEW.labeler_id) >= 2 THEN
    RAISE EXCEPTION 'relabel item % already has two labelers', NEW.item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS relabel_answer_max_two ON relabel_answer;
CREATE TRIGGER relabel_answer_max_two
  BEFORE INSERT ON relabel_answer
  FOR EACH ROW EXECUTE FUNCTION relabel_answer_max_two();

-- What a model arm answered for an item, written by the eval harness (A1). `answers` holds each
-- question's chosen option, confidence and abstained flag.
CREATE TABLE IF NOT EXISTS relabel_prediction (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES relabel_item(id) ON DELETE CASCADE,
  run_id          text NOT NULL,
  arm             text NOT NULL CHECK (arm IN ('image', 'image_signals', 'signals')),
  model           text NOT NULL,
  answers         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, arm, item_id)
);

CREATE INDEX IF NOT EXISTS relabel_prediction_item_idx ON relabel_prediction (item_id);
