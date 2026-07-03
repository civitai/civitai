import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteModelFileObject } from '~/utils/s3-utils';
import { createJob } from '~/server/jobs/job';

const GRACE_DAYS = 30;

const logJob = (data: MixedObject) =>
  logToAxiom({ name: 'purge-replaced-files', type: 'error', ...data }, 'webhooks').catch(() => {});

type ReplacedRow = { id: number; url: string };

export async function processReplacedFiles(rows: ReplacedRow[]) {
  let purged = 0;
  let failed = 0;
  for (const { id, url } of rows) {
    try {
      // Refcount-guarded: skips the S3 delete if another live ModelFile still
      // references this url. Do NOT swap for raw deleteObject.
      await deleteModelFileObject(url);
      await dbWrite.modelFile.update({ where: { id }, data: { dataPurged: true } });
      purged += 1;
    } catch (e) {
      failed += 1;
      logJob({ message: 'purge error', data: { modelFileId: id, error: (e as Error)?.message } });
    }
  }
  return { purged, failed };
}

export const purgeReplacedFilesJob = createJob(
  'purge-replaced-files',
  '15 11 * * *',
  async () => {
    const rows = await dbWrite.$queryRaw<ReplacedRow[]>`
      SELECT id, url
      FROM "ModelFile"
      WHERE "replacedAt" < now() - make_interval(days => ${GRACE_DAYS})
        AND "dataPurged" IS NOT TRUE
    `;
    if (rows.length === 0) return { status: 'ok' };
    const { purged, failed } = await processReplacedFiles(rows);
    logJob({ type: 'info', message: 'finished', data: { purged, failed } });
    return { status: 'ok' };
  }
);
