
BEGIN;
-- AlterEnum
ALTER TYPE "TagSource" ADD VALUE 'Clavata';
COMMIT;

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
    packed_attributes SMALLINT;
    source_id INTEGER;
    confidence_score INTEGER;
BEGIN
    source_id := CASE tagSource
		WHEN NULL THEN 0
        WHEN 'User' THEN 1
        WHEN 'Rekognition' THEN 2
        WHEN 'WD14' THEN 3
        WHEN 'Computed' THEN 4
        WHEN 'ImageHash' THEN 5
        WHEN 'MinorDetection' THEN 6
        WHEN 'Clavata' THEN 7
        ELSE 0  -- Default value (in case an invalid value is provided)
    END;

    confidence_score := CASE
      WHEN confidence IS NULL THEN 0
      ELSE CAST(confidence AS SMALLINT) & 127
    END;

    -- Pack the values using bitwise operations
    packed_attributes :=
      (source_id << 12)                                 -- 15-12: source (4 bits)
      | (CASE WHEN automated THEN 1 ELSE 0 END << 11)     -- 11: automated (1 bit)
      | (CASE WHEN disabled  THEN 1 ELSE 0 END << 10)     -- 10: disabled (1 bit)
      | (CASE WHEN needsReview THEN 1 ELSE 0 END << 09)   -- 09: needs review (0 bit)
      | (0 << 08)                                         -- 08: reserved (0 bit)
      | (0 << 07)                                         -- 07: reserved (0 bit)
      | confidence_score;                               -- 06-00: confidence (7 bits)

    RETURN packed_attributes;
END;
$$
LANGUAGE plpgsql;


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
    ELSE 'User'::"TagSource"  -- Default case in case source_id is outside expected range
  END AS source,
  CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
  CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
  CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS "needsReview",
  CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
  CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
  ("attributes" & 127) AS confidence
FROM "TagsOnImageNew";
COMMIT;