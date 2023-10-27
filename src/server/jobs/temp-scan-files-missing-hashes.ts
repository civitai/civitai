import { createJob, getJobDate } from './job';
import { dbRead } from '~/server/db/client';
import { getS3Client } from '~/utils/s3-utils';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { chunk } from 'lodash';

export const tempScanFilesMissingHashes = createJob(
  'scan-files-missing-hashes',
  '23 1 * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('scan-files-missing-hashes');

    // Get all files that are missing hashes
    const modelFiles = await dbRead.$queryRaw<{ id: number; url: string }[]>`
      SELECT
        mf.id,
        mf.url
      FROM "ModelFile" mf
      WHERE NOT EXISTS (SELECT 1 FROM "ModelFileHash" mfh WHERE mfh."fileId" = mf.id)
      AND (mf.exists IS NULL OR mf.exists);
    `;

    console.log(`Found ${modelFiles.length} files missing hashes`);

    // Prepare to send each file to the scanner for hashing
    const s3 = getS3Client();
    const promises = modelFiles.map(async (file) => {
      await requestScannerTasks({ file, s3, tasks: ['Hash'], lowPriority: true });
    });

    // Split promises into chunks of 50
    const batches = chunk(promises, 50);
    for (const batch of batches) await Promise.all(batch);

    await setLastRun();
  }
);
