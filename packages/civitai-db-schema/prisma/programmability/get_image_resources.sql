-- Resource detection credits an image to a model by joining image metadata to "ModelFileHash" on
-- hash VALUE. Nothing in that join says what the hash is a hash OF, so a component file that many
-- creators bundle beside their checkpoint -- an upstream text encoder, a VAE, a CLIP -- matches
-- every version hosting it, and the tie-break below hands the image to the EARLIEST published of
-- them: a stranger's model, on a page the uploader cannot correct.
--
-- Worked case (FD 69881, ClickUp 868m16ckn): the Qwen3-VL text encoder f111f9a940bc is bundled
-- under 11 published versions owned by 8 creators, so every Krea 2 creator shipping it was credited
-- to the one published first. 51 images across 7 creators on that hash alone. The metadata declared
-- the resource's role as "qwenmodel" -- the information needed to reject it was present, and unread.
-- Platform-wide, 12,812 AutoV3 hashes sit on files owned by more than one user, across 30,393
-- versions; the worst is a training-data zip on 366 versions across 258 owners.
--
-- Two filters, on the two independent signals, applied in image_resource_merge below:
--
--   1. The role the metadata declares must name something Civitai hosts as a model version. An
--      ALLOWLIST, so a component role nobody has seen yet is rejected rather than silently
--      credited, which is how "qwenmodel" got through. The cost is that a genuinely new CHECKPOINT
--      role goes undetected until it is added to resource_roles; that failure is visible to the
--      creator it affects, whereas the one it replaces is invisible to the person it robs.
--   2. The matched FILE must be able to be the resource. Training data, archives, configs and
--      workflows are not weights at all; a VAE, text encoder or CLIP vision tower is weights but
--      never the thing an image was made with. Applied independently of the role, because metadata
--      is wrong in both directions: one writer labels the bundled text encoder `checkpoint`.
--
-- A NULL role passes. Older writers omit the key, and three of the five branches below carry no
-- role at all (two of those resolve a modelVersionId directly and never join on hash).
--
-- Measured on production over 7 days of detected attributions, filter 2 removes 22 of ~366,900: 9
-- via the non-weights, 13 via the component weights. Replaying 500 recent images through both
-- bodies, matched attributions are identical at 1,616, none lost and none gained; on the reported
-- model the detected count falls 209 to 158, which is every one of the 51 attributions that came
-- through a bundled component and none of the 143 real ones.
--
-- Carried along because it is the same defect class: an empty-string hash is normalised to NULL at
-- each source, so several hashless resources on one image stop deduping against each other and all
-- of them reach the caller's "could not be matched" list instead of one arbitrary survivor.
--
-- The equivalent filters live in resolveImageMeta() in
-- src/server/services/generation/generation.service.ts, which mirrors this function for the
-- generator. Change both together.

CREATE OR REPLACE FUNCTION get_image_resources(image_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  modelVersionId INTEGER,
  name TEXT,
  hash TEXT,
  strength INTEGER,
  detected BOOLEAN
) AS $$
DECLARE
  -- Roles that name something Civitai hosts as a model version.
  resource_roles TEXT[] := ARRAY[
    'model', 'checkpoint', 'refinermodel',
    'lora', 'lycoris', 'locon', 'dora',
    'embed', 'embedding', 'textualinversion', 'used_embeddings',
    'hypernet'
  ];
  -- Real role words that are never the resource an image was made WITH. Listed only so that a key
  -- carrying one is recognised as a role at all; membership here is not what rejects it.
  component_roles TEXT[] := ARRAY[
    'vae', 'refinervae', 'clip', 'clipvision', 'cliplmodel', 'unet',
    'textencoder', 'text_encoder', 'upscaler', 'controlnet',
    'qwenmodel', 'llamamodel', 'txxlmodel', 'seedvrmodel'
  ];
  known_roles TEXT[] := resource_roles || component_roles;
BEGIN
  RETURN QUERY
  WITH image_resource_hashes AS (
    SELECT
      i.id,
      null::int as model_version_id,
      resource->>'name' as name,
      NULLIF(LOWER(resource->>'hash'), '') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected,
      LOWER(resource->>'type') as role
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'resources') AS resource
    WHERE jsonb_typeof(i.meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    -- A1111 keys this object by role: "model", "vae", "lora:<name>". Other writers key it by
    -- FILENAME ("we_paint_krea2.safetensors", "krea2_raw_to_turbo_r256_comfy"), and those match real
    -- models, so a key is only read as a role when it IS one. Anything else yields NULL and is
    -- judged on its hash alone, exactly as before.
    SELECT
      i.id,
      null::int model_version_id,
      hs.key as name,
      NULLIF(LOWER(hs.value), '') as hash,
      null::int as strength,
      true as detected,
      CASE WHEN split_part(LOWER(hs.key), ':', 1) = ANY (known_roles)
        THEN split_part(LOWER(hs.key), ':', 1) END as role
    FROM "Image" i, jsonb_each_text(i.meta->'hashes') AS hs(key, value)
    WHERE jsonb_typeof(i.meta->'hashes') = 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      COALESCE(i.meta->>'Model','model') as name,
      NULLIF(LOWER(i.meta->>'Model hash'), '') as hash,
      null::int as strength,
      true as detected,
      'model' as role
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'Model hash') = 'string'
      AND jsonb_typeof(i.meta->'hashes') != 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      (civitai_resource->>'modelVersionId')::int as model_version_id,
      civitai_resource->>'type' as name,
      null as hash,
      iif(civitai_resource->>'weight' IS NOT NULL, round((civitai_resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected,
      null as role
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'civitaiResources') AS civitai_resource
    WHERE jsonb_typeof(i.meta->'civitaiResources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      mv.id model_version_id,
      CONCAT(m.name,' - ', mv.name) as name,
      (
        SELECT DISTINCT ON ("modelVersionId")
          LOWER(mfh.hash)
        FROM "ModelFile" mf
        JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
        WHERE mf.type = 'Model' AND mfh.type = 'AutoV2'
        AND mf."modelVersionId" = mv.id
      ) as hash,
      null::int as strength,
      false as detected,
      null as role
    FROM "Image" i
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation')
    WHERE i.id = image_id
  ), image_resource_merge AS (
    SELECT
      irh.id,
      COALESCE(irh.model_version_id, mf."modelVersionId") AS "modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      mv.status = 'Published' AS version_published,
      COALESCE(mv."publishedAt", mv."createdAt") AS version_date,
      mf.id AS file_id
    FROM image_resource_hashes irh
    LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash::citext
    LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
    LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE (irh.name IS NULL OR irh.name != 'vae')
      AND (m.id IS NULL OR m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation'))
      AND (irh.hash IS NULL OR irh.hash != 'e3b0c44298fc') -- the sha256 of empty content
      AND (irh.role IS NULL OR irh.role = ANY (resource_roles))
      -- mf.id first, deliberately: mf.type is NULL on an unmatched row, and a bare
      -- `NOT (NULL IN (...))` evaluates to NULL rather than TRUE, which discards every one of them.
      AND (mf.id IS NULL OR mf.type NOT IN (
        'Training Data', 'Archive', 'Config', 'Workflow',
        'VAE', 'Text Encoder', 'CLIPVision'
      ))
  ), image_resource_id AS (
    SELECT
      irh.id,
      irh."modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      row_number() OVER (PARTITION BY irh.id, irh.hash ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number,
      -- PARTITION BY groups NULLs, so without this every unmatched row on an image dedupes
      -- against every other and only one survives. They still dedupe by hash via row_number.
      CASE WHEN irh."modelVersionId" IS NULL THEN 1 ELSE
        row_number() OVER (PARTITION BY irh.id, irh."modelVersionId" ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id)
      END AS row_number_version
    FROM image_resource_merge irh
  )
  SELECT
    iri.id,
    iri."modelVersionId",
    REPLACE(REPLACE(REPLACE(iri.name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') AS name,
    iri.hash,
    iri.strength,
    iri.detected
  FROM image_resource_id iri
  LEFT JOIN "ModelVersion" mv ON mv.id = iri."modelVersionId"
  WHERE ((iri.row_number = 1 AND iri.row_number_version = 1) OR iri.hash IS NULL)
    AND (
      mv.id IS NULL OR
      mv.meta IS NULL OR
      mv.meta->>'excludeFromAutoDetection' IS NULL
    );
END;
$$ LANGUAGE plpgsql;
