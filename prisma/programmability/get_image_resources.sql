CREATE OR REPLACE FUNCTION get_image_resources(image_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  modelVersionId INTEGER,
  name TEXT,
  hash TEXT,
  strength INTEGER,
  detected BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH image_resource_hashes AS (
    SELECT
      i.id,
      null::int as model_version_id,
      resource->>'name' as name,
      LOWER(resource->>'hash') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(i.meta->'resources') AS resource
    WHERE jsonb_typeof(i.meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      (jsonb_each_text(i.meta->'hashes')).key as name,
      LOWER((jsonb_each_text(i.meta->'hashes')).value) as hash,
      null::int as strength,
      true as detected
    FROM "Image" i
    WHERE jsonb_typeof(i.meta->'hashes') = 'object'
      AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      null::int model_version_id,
      COALESCE(i.meta->>'Model','model') as name,
      LOWER(i.meta->>'Model hash') as hash,
      null::int as strength,
      true as detected
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
      true as detected
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
      false as detected
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
      AND (irh.hash IS NULL OR irh.hash != 'e3b0c44298fc') -- Exclude empty hash
  ), image_resource_id AS (
    SELECT
      irh.id,
      irh."modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      row_number() OVER (PARTITION BY irh.id, irh.hash ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number,
      row_number() OVER (PARTITION BY irh.id, irh."modelVersionId" ORDER BY IIF(irh.detected,0,1), IIF(irh.strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) AS row_number_version
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
