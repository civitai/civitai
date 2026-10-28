import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { heldModelIdsSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { legalHoldSkipReason } from '~/server/utils/legal-hold';
import { deleteModelFileObject } from '~/utils/s3-utils';
import { createJob } from '~/server/jobs/job';

const GRACE_DAYS = 30;

const logJob = (data: MixedObject) =>
  logToAxiom({ name: 'purge-replaced-files', type: 'error', ...data }, 'webhooks').catch(() => {});

type ReplacedRow = { id: number; url: string; held: boolean };

export async function processReplacedFiles(rows: ReplacedRow[]) {
  let purged = 0;
  let failed = 0;
  let skipped = 0;
  for (const { id, url, held } of rows) {
    const holdReason = legalHoldSkipReason(held);
    if (holdReason) {
      skipped += 1;
      logJob({
        type: 'info',
        message: 'purge skipped, object left in place',
        data: { modelFileId: id, reason: holdReason },
      });
      continue;
    }
    try {
      // Refcount-guarded: skips the S3 delete if another live ModelFile still
      // references this url. Do NOT swap for raw deleteObject. excludeId=id is
      // required — this job keeps the row (only sets dataPurged), so without
      // excluding its own id the guard would always find the row as a "live"
      // reference to its own url and silently no-op forever.
      const outcome = await deleteModelFileObject(url, id);
      // 🔴 A SKIP IS NOT A PURGE. Every non-deleting outcome means the object is still there, so
      // setting `dataPurged` on one records a deletion that did not happen and drops the row out
      // of this query permanently while the bytes remain. It used to do exactly that, because the
      // helper reported a skip and a success identically (both "did not throw"). A skip is not a
      // failure either — `still-referenced` is the guard working — so it is counted separately.
      if (!outcome.deleted) {
        skipped += 1;
        logJob({
          type: 'info',
          message: 'purge skipped, object left in place',
          data: { modelFileId: id, reason: outcome.reason },
        });
        continue;
      }
      await dbWrite.modelFile.update({ where: { id }, data: { dataPurged: true } });
      purged += 1;
    } catch (e) {
      failed += 1;
      logJob({ message: 'purge error', data: { modelFileId: id, error: (e as Error)?.message } });
    }
  }
  return { purged, failed, skipped };
}

// The grace period is inlined as a literal: Prisma binds a JS number as int8 and
// `make_interval` only takes int4, so an interpolated parameter fails to resolve the
// function (42883) at plan time — the statement throws before any row is examined.
// A file whose version is gone has no model to check, so its `held` is NULL and it is skipped.
export function buildReplacedFilesQuery(markerView: boolean): Prisma.Sql {
  return Prisma.sql`
    WITH replaced AS MATERIALIZED (
      SELECT mf.id, mf.url, mv."modelId"
      FROM "ModelFile" mf
      LEFT JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      WHERE mf."replacedAt" < now() - make_interval(days => ${Prisma.raw(String(GRACE_DAYS))})
        AND mf."dataPurged" IS NOT TRUE
    )
    SELECT r.id, r.url, r."modelId" IN (${heldModelIdsSql(
      Prisma.sql`SELECT "modelId" FROM replaced`,
      markerView
    )}) AS held
    FROM replaced r
  `;
}

export const purgeReplacedFilesJob = createJob('purge-replaced-files', '15 11 * * *', async () => {
  const rows = await dbWrite.$queryRaw<ReplacedRow[]>(
    buildReplacedFilesQuery(await holdMarkerViewExists())
  );
  if (rows.length === 0) return { status: 'ok' };
  const { purged, failed, skipped } = await processReplacedFiles(rows);
  logJob({ type: 'info', message: 'finished', data: { purged, failed, skipped } });
  return { status: 'ok' };
});
