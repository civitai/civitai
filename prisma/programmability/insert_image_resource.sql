CREATE OR REPLACE FUNCTION insert_image_resource(image_id INTEGER)
RETURNS VOID AS $$
BEGIN
	WITH image_resource_hashes AS (
		SELECT id, null::int model_version_id, (jsonb_each_text(meta->'hashes')).key as name, (jsonb_each_text(meta->'hashes')).value as hash, true as detected
		FROM "Image"
		WHERE jsonb_typeof(meta->'hashes') = 'object'
			AND id = image_id

		UNION

		SELECT id, null::int model_version_id, COALESCE(meta->>'Model','model') as name, meta->>'Model hash' as hash, true as detected
		FROM "Image"
		WHERE jsonb_typeof(meta->'Model hash') = 'string'
			AND jsonb_typeof(meta->'hashes') != 'object'
			AND id = image_id

		UNION

		SELECT i.id, mv.id model_version_id, CONCAT(m.name,' - ', mv.name), LOWER(mf.hash) "hash", false as detected
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
	), image_resource_id AS (
		SELECT DISTINCT
		  irh.id,
		  COALESCE(irh.model_version_id, mf."modelVersionId") "modelVersionId",
		  irh.name,
		  irh.hash,
		  irh.detected,
			row_number() OVER (PARTITION BY irh.id, irh.hash ORDER BY IIF(irh.detected,0,1), mf.id) row_number
		FROM image_resource_hashes irh
		LEFT JOIN "ModelFileHash" mfh ON LOWER(mfh.hash) = LOWER(irh.hash)
		LEFT JOIN "ModelFile" mf ON mf.id = mfh."fileId"
		LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
		LEFT JOIN "Model" m ON m.id = mv."modelId"
		WHERE irh.name != 'vae' AND m.status != 'Deleted'
	)
	INSERT INTO "ImageResource"("imageId", "modelVersionId", name, hash, detected)
	SELECT
	  id,
	  "modelVersionId",
	  REPLACE(REPLACE(REPLACE(name, 'hypernet:', ''), 'embed:', ''), 'lora:', '') "name",
	  hash,
	  detected
	FROM image_resource_id iri
	WHERE row_number = 1
		AND NOT EXISTS (
		  SELECT 1 FROM "ImageResource" ir
		  WHERE "imageId" = iri.id
		    AND (ir.hash = iri.hash OR ir."modelVersionId" = iri."modelVersionId")
		)
	ON CONFLICT ("imageId", "modelVersionId", "name") DO UPDATE SET detected = true, hash = excluded.hash;
END;
$$ LANGUAGE plpgsql;