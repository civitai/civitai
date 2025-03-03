DROP VIEW IF EXISTS "TagsOnImageDetails";
DROP TABLE IF EXISTS "TagsOnImageNew";

CREATE TABLE "TagsOnImageNew" (
  "imageId" integer NOT NULL,
  "tagId" integer NOT NULL,
  "attributes" smallint NOT NULL,
  PRIMARY KEY ("imageId", "tagId")
);

CREATE OR REPLACE FUNCTION upsert_tag_on_image(
  imageId integer,
  tagId integer,
  tagSource "TagSource",
  automated bool,
  confidence smallint,
  disabled bool
)
RETURNS VOID AS
$$
DECLARE
    packed_attributes SMALLINT;
    source_id INTEGER;
BEGIN
    source_id := CASE tagSource
        WHEN 'User' THEN 1
        WHEN 'Rekognition' THEN 2
        WHEN 'WD14' THEN 3
        WHEN 'Computed' THEN 4
        WHEN 'ImageHash' THEN 5
        WHEN 'MinorDetection' THEN 6
        ELSE 0  -- Default value (in case an invalid value is provided)
    END;

-- Pack the values using bitwise operations
    packed_attributes :=
        (source_id << 12)                                 -- 15-12: source (4 bits)
      | (CASE WHEN automated THEN 1 ELSE 0 END << 11)     -- 11: automated (1 bit)
      | (CASE WHEN disabled  THEN 1 ELSE 0 END << 10)     -- 10: disabled (1 bit)
      | (0 << 09)                                         -- 09: needs review (0 bit)
      | (0 << 08)                                         -- 08: reserved (0 bit)
      | (0 << 07)                                         -- 07: reserved (0 bit)
      | (confidence & 127);                               -- 06-00: confidence (7 bits)

    -- Insert the record into the TagsOnImageNew table
    INSERT INTO "TagsOnImageNew" ("imageId", "tagId", "attributes")
    VALUES (imageId, tagId, packed_attributes)
		ON CONFLICT ("imageId", "tagId") DO UPDATE
    	SET "attributes" = excluded."attributes";  -- Replace the attributes on conflict
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
    ELSE 'User'::"TagSource"  -- Default case in case source_id is outside expected range
  END AS sourceId,
  CASE WHEN ("attributes" >> 11) & 1 = 1 THEN TRUE ELSE FALSE END AS automated,
  CASE WHEN ("attributes" >> 10) & 1 = 1 THEN TRUE ELSE FALSE END AS disabled,
  CASE WHEN ("attributes" >> 9) & 1 = 1 THEN TRUE ELSE FALSE END AS needsReview,
  CASE WHEN ("attributes" >> 8) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_1,
  CASE WHEN ("attributes" >> 7) & 1 = 1 THEN TRUE ELSE FALSE END AS reserved_2,
  ("attributes" & 127) AS confidence
FROM "TagsOnImageNew";