-- Give the TagSource values that had no code their own source code, so they stop
-- packing as 0 (which TagsOnImageDetails reads back as 'User'). New writes only;
-- existing rows keep source 0.
--
-- "attributes" is a SMALLINT and the source sits in bits 12-15, so codes 8-15 set
-- the sign bit: those rows store a negative value (two's complement). Every decoder
-- reads the source as (attributes >> 12) & 15, and >> on a smallint is arithmetic,
-- so a negative row still decodes to 8-15 and the lower bits are unchanged.
--
-- Apply only after the code that reads codes 8-12 is live.

BEGIN;

CREATE OR REPLACE FUNCTION get_tag_on_image_attributes(
  tagSource "TagSource" default null,
  confidence integer default null,
  automated bool default null,
  disabled bool default null,
  needsReview bool default null
)
RETURNS INTEGER AS $$
DECLARE
    packed_attributes INTEGER;
    source_id INTEGER;
    confidence_score INTEGER;
BEGIN
    -- A NULL tagSource matches no arm and falls to ELSE 0.
    source_id := CASE tagSource
        WHEN 'User' THEN 1
        WHEN 'Rekognition' THEN 2
        WHEN 'WD14' THEN 3
        WHEN 'Computed' THEN 4
        WHEN 'ImageHash' THEN 5
        WHEN 'MinorDetection' THEN 6
        WHEN 'Clavata' THEN 7
        WHEN 'Hive' THEN 8
        WHEN 'HiveDemographics' THEN 9
        WHEN 'SpineRating' THEN 10
        WHEN 'AiRecognition' THEN 11
        WHEN 'AnimeRecognition' THEN 12
        ELSE 0
    END;

    confidence_score := CASE
      WHEN confidence IS NULL THEN 0
      ELSE confidence & 127
    END;

    packed_attributes :=
      (source_id << 12)                                   -- 15-12: source (4 bits)
      | (CASE WHEN automated THEN 1 ELSE 0 END << 11)     -- 11: automated
      | (CASE WHEN disabled  THEN 1 ELSE 0 END << 10)     -- 10: disabled
      | (CASE WHEN needsReview THEN 1 ELSE 0 END << 09)   -- 09: needs review
      | confidence_score;                                 -- 06-00: confidence

    -- Reinterpret bit 15 as the smallint sign bit.
    IF packed_attributes >= 32768 THEN
      packed_attributes := packed_attributes - 65536;
    END IF;

    RETURN packed_attributes;
END;
$$
LANGUAGE plpgsql;

-- 65408 (0xFF80) turned a negative row positive (-32768 -> 32768), which overflows
-- the smallint column on the upsert's ON CONFLICT path. ~127 keeps the sign.
CREATE OR REPLACE FUNCTION manipulate_bits_confidence(attributes integer, confidence integer default null)
RETURNS INTEGER AS $$
BEGIN
  RETURN CASE
    WHEN confidence IS NULL THEN attributes
    ELSE attributes & ~127
  END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW "TagsOnImageDetails" AS
SELECT
  "imageId",
  "tagId",
  CASE
    WHEN (("attributes" >> 12) & 15) = 1 THEN 'User'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 2 THEN 'Rekognition'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 3 THEN 'WD14'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 4 THEN 'Computed'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 5 THEN 'ImageHash'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 6 THEN 'MinorDetection'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 7 THEN 'Clavata'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 8 THEN 'Hive'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 9 THEN 'HiveDemographics'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 10 THEN 'SpineRating'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 11 THEN 'AiRecognition'::"TagSource"
    WHEN (("attributes" >> 12) & 15) = 12 THEN 'AnimeRecognition'::"TagSource"
    ELSE 'User'::"TagSource"
  END AS source,
  CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
  CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
  CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS "needsReview",
  CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
  CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
  ("attributes" & 127) AS confidence
FROM "TagsOnImageNew";

COMMIT;
