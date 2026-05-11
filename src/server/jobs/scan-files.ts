import type { ModelType } from '~/shared/utils/prisma/enums';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';

import { dbWrite } from '~/server/db/client';

import { createJob } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

// Fallback job: resubmits orchestrator scan workflows for files that were missed
// or whose scans stalled. Runs every 5 minutes, picks up files where:
// - virusScanResult is still Pending
// - scanRequestedAt is null (never submitted) or older than 1 day (stalled)
const SCAN_FALLBACK_CONCURRENCY = 10;
const SCAN_FALLBACK_BATCH_SIZE = 200;

// Job key kept as `scan-files-fallback` for operational continuity with the
// pre-deprecation cron registry. The legacy `scan-files` job was removed when
// the orchestrator path became the only scan path.
export const scanFilesFallbackJob = createJob('scan-files-fallback', '*/5 * * * *', async () => {
  const scanCutOff = dayjs().subtract(1, 'day').toDate();

  const files = await dbWrite.modelFile.findMany({
    where: {
      virusScanResult: ScanResultCode.Pending,
      AND: [
        { OR: [{ exists: null }, { exists: true }] },
        { OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }] },
      ],
    },
    select: {
      id: true,
      url: true,
      modelVersion: {
        select: {
          id: true,
          baseModel: true,
          model: { select: { id: true, type: true } },
        },
      },
    },
    take: SCAN_FALLBACK_BATCH_SIZE,
  });

  if (files.length === 0) return { submitted: 0 };

  // Mark batch as requested upfront so overlapping runs won't re-process
  await dbWrite.modelFile.updateMany({
    where: { id: { in: files.map((f) => f.id) } },
    data: { scanRequestedAt: new Date() },
  });

  let submitted = 0;
  let failed = 0;
  await limitConcurrency(
    files.map((file) => async () => {
      // Defensive: a soft-deleted ModelVersion would null this out and crash
      // the whole batch. Skip and count as failed instead.
      if (!file.modelVersion) {
        failed++;
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { scanRequestedAt: null } })
          .catch(() => null);
        return;
      }
      try {
        await createModelFileScanRequest({
          fileId: file.id,
          modelVersionId: file.modelVersion.id,
          modelId: file.modelVersion.model.id,
          modelType: file.modelVersion.model.type as ModelType,
          baseModel: file.modelVersion.baseModel,
          url: file.url,
          priority: 'low',
        });
        submitted++;
      } catch (err) {
        failed++;
        const isNotFound = err instanceof ModelFileScanSubmissionError && err.code === 'not-found';
        if (isNotFound) {
          // Orchestrator says the AIR can't be resolved — file is genuinely
          // gone. Tombstone via exists=false so this job's WHERE clause skips
          // it on subsequent runs (`{ OR: [{ exists: null }, { exists: true }] }`).
          await dbWrite.modelFile
            .update({ where: { id: file.id }, data: { exists: false } })
            .catch(() => null);
        } else {
          // Reset scanRequestedAt so the next 5-min tick retries this file.
          // Without this, the upfront updateMany above would leave it Pending
          // for the 24h stale-cutoff window — too long for transient
          // orchestrator outages, which are the common case for submission
          // failures (vs. workflow-level failures handled by D4).
          await dbWrite.modelFile
            .update({ where: { id: file.id }, data: { scanRequestedAt: null } })
            .catch(() => null);
        }
        logToAxiom(
          {
            type: 'error',
            name: 'scan-files-fallback',
            message: `Failed to submit scan workflow for file ${file.id}`,
            submissionErrorCode:
              err instanceof ModelFileScanSubmissionError ? err.code : 'transient',
            tombstoned: isNotFound,
            error: err instanceof Error ? err.message : String(err),
          },
          'webhooks'
        ).catch();
      }
    }),
    SCAN_FALLBACK_CONCURRENCY
  );

  return { submitted, failed };
});
