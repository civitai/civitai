import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { sweepMinorHashMatches } from '~/server/services/minor-hash.service';
import { createJob } from './job';

// Catches what the scan-time hook cannot: a copy uploaded before the original
// was flagged, whose scan has already run. Gated on the same kill switch as the
// scan hook so both unattended paths stop together, without a deployment.
// Default-off: isFlipt returns false for an unknown flag or an unreachable
// Flipt, so this stays dormant until someone turns it on deliberately.
export const minorHashSweep = createJob('minor-hash-sweep', '45 3 * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG))) return;

  return await sweepMinorHashMatches({ dryRun: false, limit: 500 });
});
