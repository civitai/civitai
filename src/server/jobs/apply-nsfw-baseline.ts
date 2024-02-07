import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const applyNsfwBaseline = createJob('apply-nsfw-baseline', '* * * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('apply-nsfw-baseline');

  // Update NSFW baseline
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Update NSFW baseline
    WITH to_update AS (
      SELECT array_agg(i.id) ids
      FROM "Image" i
      WHERE "scannedAt" > ${lastRun}
        AND ingestion = 'Scanned'
    )
    SELECT update_nsfw_levels(ids)
    FROM to_update;
  `;

  await setLastRun();
});
