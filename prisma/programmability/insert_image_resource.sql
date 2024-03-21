CREATE OR REPLACE FUNCTION insert_image_resource(image_id INTEGER)
RETURNS VOID AS $$
BEGIN
	WITH image_resource_hashes AS (
    SELECT
      id,
      null::int as model_version_id,
      resource->>'name' as name,
      UPPER(resource->>'hash') as hash,
      iif(resource->>'weight' IS NOT NULL, round((resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(meta->'resources') AS resource
    WHERE jsonb_typeof(meta->'resources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      id,
      null::int model_version_id,
      (jsonb_each_text(meta->'hashes')).key as name,
      UPPER((jsonb_each_text(meta->'hashes')).value) as hash,
      null::int as strength,
      true as detected
    FROM "Image"
    WHERE jsonb_typeof(meta->'hashes') = 'object'
      AND id = image_id

    UNION ALL

    SELECT
      id,
      null::int model_version_id,
      COALESCE(meta->>'Model','model') as name,
      UPPER(meta->>'Model hash') as hash,
      null::int as strength,
      true as detected
    FROM "Image"
    WHERE jsonb_typeof(meta->'Model hash') = 'string'
      AND jsonb_typeof(meta->'hashes') != 'object'
      AND id = image_id

    UNION ALL

    SELECT
      id,
      (civitai_resource->>'modelVersionId')::int as model_version_id,
      civitai_resource->>'type' as name,
      null as hash,
      iif(civitai_resource->>'weight' IS NOT NULL, round((civitai_resource->>'weight')::double precision * 100)::int, 100) as strength,
      true as detected
    FROM
      "Image" i,
      jsonb_array_elements(meta->'civitaiResources') AS civitai_resource
    WHERE jsonb_typeof(meta->'civitaiResources') = 'array' AND i.id = image_id

    UNION ALL

    SELECT
      i.id,
      mv.id model_version_id,
      CONCAT(m.name,' - ', mv.name),
      UPPER(mf.hash) "hash",
      null::int as strength,
      false as detected
    FROM "Image" i
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND m.status != 'Deleted'
    LEFT JOIN (
      SELECT mf."modelVersionId", MIN(mfh.hash) hash
      FROM "ModelFile" mf
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
      WHERE mf.type = 'Model' AND mfh.type = 'AutoV2'
      GROUP BY mf."modelVersionId"
    ) mf ON mf."modelVersionId" = p."modelVersionId"
    WHERE i.id = image_id
  ), image_resource_merge AS (
    SELECT
      irh.id,
      COALESCE(irh.model_version_id, mf."modelVersionId") "modelVersionId",
      irh.name,
      irh.hash,
      irh.strength,
      irh.detected,
      mv.status = 'Published' as version_published,
      COALESCE(mv."publishedAt", mv."createdAt") as version_date,
      mf.id as file_id
    FROM image_resource_hashes irh
    LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash
    LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
    LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    LEFT JOIN "Model" m ON m.id = mv."modelId"
    WHERE irh.name != 'vae'
      AND (m.id IS NULL OR m.status != 'Deleted')
  ), image_resource_id AS (
    SELECT
      *,
      row_number() OVER (PARTITION BY id, "hash" ORDER BY IIF(detected,0,1), IIF(strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) row_number,
      row_number() OVER (PARTITION BY id, "modelVersionId" ORDER BY IIF(detected,0,1), IIF(strength IS NOT NULL,0,1), IIF(version_published,0,1), version_date, file_id) row_number_version
    FROM image_resource_merge
  )
  INSERT INTO "ImageResource"("imageId", "modelVersionId", name, hash, strength, detected)
  SELECT
    iri.id,
    iri."modelVersionId",
    REPLACE(REPLACE(REPLACE(iri.name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') as "name",
    iri.hash,
    iri.strength,
    iri.detected
  FROM image_resource_id iri
  LEFT JOIN "ModelVersion" mv ON mv.id = iri."modelVersionId"
  WHERE ((row_number = 1 AND row_number_version = 1) OR iri.hash IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM "ImageResource" ir
      WHERE "imageId" = iri.id
        AND (ir.hash = iri.hash OR ir."modelVersionId" = iri."modelVersionId")
    )
    AND (
      mv.id IS NULL OR
      mv.meta IS NULL OR
      mv.meta->>'excludeFromAutoDetection' IS NULL
    )
  ON CONFLICT ("imageId", "modelVersionId", "name") DO UPDATE SET detected = true, hash = excluded.hash, strength = excluded.strength;
END;
$$ LANGUAGE plpgsql;
