import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const cleanImageResources = createJob('clean-image-resources', '8 */1 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('clean-image-resources');
  console.log('Running clean-image-resources job', lastRun);

  // await applyMissingModelVersions(lastRun);
  // await applyMissingHashes(lastRun); // No reason to do this...
  // await removeRepeats(lastRun);

  await setLastRun();
});

// need to adapt this to ImageResourceNew if we want to keep using this.
// !! column "hash" does not exist on ImageResourceNew
const applyMissingModelVersions = (since: Date) => dbWrite.$executeRaw`
  -- Apply missing model versions
  WITH found_hashes AS (
    SELECT
      mf."modelVersionId",
      ir.id,
      ir.hash,
      row_number() OVER (PARTITION BY ir.hash ORDER BY mf.id) row_num
    FROM "ImageResource" ir
    JOIN "ModelFileHash" mfh ON mfh.hash = ir.hash
    JOIN "ModelFile" mf ON mfh."fileId" = mf.id
    JOIN "Image" i ON i.id = ir."imageId"
    WHERE ir."modelVersionId" IS NULL AND ir.hash IS NOT NULL
    AND i."createdAt" > ${since}
  )
  UPDATE "ImageResource" ir SET "modelVersionId" = fh."modelVersionId"
  FROM found_hashes fh
  WHERE fh.row_num = 1 AND fh.id = ir.id
  AND NOT EXISTS (SELECT 1 FROM "ImageResource" ir2 WHERE ir2."imageId" = ir."imageId" AND ir2."modelVersionId" = fh."modelVersionId");
`;

// const applyMissingHashes = (since: Date) => dbWrite.$executeRaw`
//   -- Apply missing hashes
//   WITH found_hashes AS (
//     SELECT
//     ir.id,
//     mfh.hash,
//     row_number() OVER (PARTITION BY mf."modelVersionId" ORDER BY "fileId") row_num
//     FROM "ImageResource" ir
//     JOIN "Image" i ON i.id = ir."imageId"
//     JOIN "ModelFile" mf ON mf."modelVersionId" = ir."modelVersionId" AND mf.type = 'Model'
//     JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'AutoV2'
//     WHERE ir.hash IS NULL AND i."createdAt" > ${since}
//   )
//   UPDATE "ImageResource" ir SET hash = fh.hash
//   FROM found_hashes fh
//   WHERE fh.row_num = 1 AND fh.id = ir.id;
// `;

// const removeRepeats = (since: Date) => dbWrite.$executeRaw`
//   -- Remove duplicates
//   WITH resource_repetition AS (
//     SELECT ir.id, "modelVersionId", "imageId", ir."hash", row_number() OVER (PARTITION BY "modelVersionId", "imageId" ORDER BY ir.id) row_num
//     FROM "ImageResource" ir
//     JOIN "Image" i ON i.id = ir."imageId"
//     WHERE ir."modelVersionId" IS NOT NULL AND i."createdAt" > ${since}
//   )
//   DELETE FROM "ImageResource" ir
//   WHERE ir.id IN (SELECT id FROM resource_repetition WHERE row_num > 1);
// `;
