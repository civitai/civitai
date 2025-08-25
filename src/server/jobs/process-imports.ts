import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { ImportStatus } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { processImport } from '~/server/importers/importRouter';

export const processImportsJob = createJob('process-imports', '1 */1 * * *', async () => {
  // Get pending import jobs that are older than 30 minutes
  const importJobs = await dbWrite.import.findMany({
    where: {
      status: ImportStatus.Pending,
      createdAt: { lt: dayjs().add(-30, 'minutes').toDate() },
    },
  });

  // Process the pending jobs
  for (const batch of chunk(importJobs, 10)) {
    try {
      await Promise.all(batch.map((job) => processImport(job)));
    } catch (e) {} // We handle this inside the processImport...
  }
});
