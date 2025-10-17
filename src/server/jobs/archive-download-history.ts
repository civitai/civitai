import dayjs from 'dayjs';
import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const archiveDownloadHistory = createJob(
  'archive-download-history',
  '0 2 1 * *',
  async () => {
    const cutoff = dayjs().subtract(12, 'months').toDate();
    // Archive download history older than 12 months
    await dbWrite.$executeRaw`
      INSERT INTO "DownloadHistoryArchive"
      SELECT * FROM "DownloadHistory"
      WHERE "downloadAt" < ${cutoff}
    `;

    // Delete archived records from the main table
    await dbWrite.$executeRaw`
      DELETE FROM "DownloadHistory"
      WHERE "downloadAt" < ${cutoff}
    `;
  }
);
