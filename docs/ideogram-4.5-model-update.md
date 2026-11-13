# Ideogram 4.5 — model version + description

Data changes for adding **Ideogram 4.5** as an API-only version of the official **Ideogram 4**
model (`2872974`, `CivitaiOfficial`). Apply them by hand to each environment; we do not run
`prisma migrate deploy`.

| Field | Value |
| --- | --- |
| Model | `2872974` — `Ideogram 4`, Checkpoint, Published |
| Existing version | `3246186` — `ideogram-4`, base model `Ideogram 4.0`, hosted weights |
| New version | `Ideogram 4.5`, base model **`Ideogram 4.5`**, `Draft`, `ExternalGeneration` (no files) |

`Ideogram 4.5` is a new `BaseModelRecord.name` in
[basemodel.constants.ts](../packages/civitai-shared/src/basemodel.constants.ts), in the existing
`Ideogram` ecosystem. Writing the row directly skips `modelVersion.upsert`'s check of `baseModel`
against the running server's constants, so it does not wait on that deploy — but editing the
version through the UI fails until the constants are live.

## 1. Create the version

The new version takes index 0 and the existing versions shift down one, as `modelVersion.upsert`
does on create. Unlike upsert, it leaves `availability` at the schema default `Public`; the
`Draft` status is what keeps it off the model page. Both statements skip if the version already
exists, so a re-run is a no-op.

```sql
BEGIN;

UPDATE "ModelVersion"
SET index = index + 1
WHERE "modelId" = 2872974
  AND NOT EXISTS (
    SELECT 1 FROM "ModelVersion" WHERE "modelId" = 2872974 AND "baseModel" = 'Ideogram 4.5'
  );

INSERT INTO "ModelVersion"
  ("modelId", name, "baseModel", status, "usageControl", "uploadType", "trainedWords", index, "updatedAt")
SELECT 2872974, 'Ideogram 4.5', 'Ideogram 4.5', 'Draft', 'ExternalGeneration', 'Created', '{}', 0, now()
WHERE NOT EXISTS (
  SELECT 1 FROM "ModelVersion" WHERE "modelId" = 2872974 AND "baseModel" = 'Ideogram 4.5'
)
RETURNING id;

COMMIT;
```

Applied to prod as `3375798`. Generation support hardcodes that id (`ideogramVersionIds['v4.5']`
in `src/shared/form-graph/generation/image/ideogram.graph.ts`); in another environment, change it
to the returned `id`. Coverage and the gate rule take the same id.

## 2. Model description

Prepends an Ideogram 4.5 section and an `Ideogram 4` heading to the current description, leaving
the existing Ideogram 4 text untouched. Skips if the 4.5 section is already there.

```sql
UPDATE "Model"
SET description = $md$<h2>Ideogram 4.5</h2><p><strong>Ideogram 4.5</strong> is the latest image model from <a target="_blank" rel="ugc" href="https://ideogram.ai">Ideogram</a>, available in the Civitai generator. Unlike Ideogram 4, it runs on Ideogram's hosted API, so this version has no files to download and does not take LoRAs.</p><ul><li><p><strong>Accurate text rendering</strong> for posters, logos and other typography-led designs.</p></li><li><p><strong>Generation and editing.</strong> Create images from a prompt, or edit a source image, guided by up to three reference images.</p></li><li><p><strong>Quality tiers.</strong> Choose low, medium or high quality to trade cost against fidelity.</p></li></ul><p><em>Use of Ideogram 4.5 is subject to the <a target="_blank" rel="ugc" href="https://ideogram.ai/legal/tos">Ideogram Terms of Service</a>.</em></p><h2>Ideogram 4</h2>$md$ || description
WHERE id = 2872974
  AND description NOT LIKE '<h2>Ideogram 4.5</h2>%';
```

## 3. Correct the description already applied to prod

The first version of §2 promised masked editing, which the generator does not offer.

```sql
UPDATE "Model"
SET description = replace(
  description,
  'guided by reference images and optionally limited to a masked region.',
  'guided by up to three reference images.'
)
WHERE id = 2872974;
```

## Verify

```sql
SELECT mv.id, mv.name, mv."baseModel", mv.status, mv."usageControl", mv.index,
       left(m.description, 40) AS desc_preview
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv."modelId" = 2872974
ORDER BY mv.index;
```

Expect `Ideogram 4.5` at index 0 as a `Draft` with `ExternalGeneration`, `ideogram-4` at index 1,
and the preview starting `<h2>Ideogram 4.5</h2>`.
