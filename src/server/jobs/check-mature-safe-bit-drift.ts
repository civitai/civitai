import { logToAxiom } from '~/server/logging/client';
import {
  enqueueMatureSafeBitDrift,
  MATURE_SAFE_BIT_DRIFT_CAP,
} from '~/server/services/nsfw-rollup-drift.service';
import { createJob } from './job';

export const checkMatureSafeBitDrift = createJob(
  'check-mature-safe-bit-drift',
  '30 4 * * *',
  async () => {
    const result = await enqueueMatureSafeBitDrift();
    const { versionCount, modelCount, overCap, enqueuedVersions, enqueuedModels } = result;
    if (overCap) {
      await logToAxiom({
        type: 'error',
        name: 'mature-safe-bit-drift',
        message: `${
          versionCount + modelCount
        } drifted rows, over the cap of ${MATURE_SAFE_BIT_DRIFT_CAP}; nothing queued`,
        versionCount,
        modelCount,
      });
    } else if (versionCount + modelCount > 0) {
      await logToAxiom({
        type: 'warning',
        name: 'mature-safe-bit-drift',
        message: `queued ${enqueuedVersions} versions and ${enqueuedModels} models for recompute`,
        versionCount,
        modelCount,
      });
    }
    return result;
  }
);
