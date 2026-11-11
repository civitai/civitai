import { logToAxiom } from '~/server/logging/client';
import {
  countMatureSafeBitDrift,
  enqueueMatureSafeBitDrift,
} from '~/server/services/nsfw-rollup-drift.service';
import { createJob } from './job';

/** Above this many drifted rows a night, something is producing them: alert, and queue nothing. */
export const MATURE_SAFE_BIT_DRIFT_CAP = 500;

export const checkMatureSafeBitDrift = createJob(
  'check-mature-safe-bit-drift',
  '30 4 * * *',
  async () => {
    const counts = await countMatureSafeBitDrift();
    const total = counts.versionCount + counts.modelCount;
    if (total > MATURE_SAFE_BIT_DRIFT_CAP) {
      await logToAxiom({
        type: 'error',
        name: 'mature-safe-bit-drift',
        message: `${total} drifted rows, over the cap of ${MATURE_SAFE_BIT_DRIFT_CAP}; nothing queued`,
        ...counts,
      });
      return { ...counts, enqueued: 0 };
    }
    if (total === 0) return { ...counts, enqueued: 0 };

    const { versionIds, modelIds } = await enqueueMatureSafeBitDrift();
    await logToAxiom({
      type: 'warning',
      name: 'mature-safe-bit-drift',
      message: `queued ${versionIds.length} versions and ${modelIds.length} models for recompute`,
      ...counts,
      versionIds,
      modelIds,
    });
    return { ...counts, enqueued: versionIds.length + modelIds.length };
  }
);
