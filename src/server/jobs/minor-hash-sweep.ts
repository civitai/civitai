import { sweepMinorHashMatches } from '~/server/services/minor-hash.service';
import { createJob } from './job';

// Catches what the scan-time hook cannot: a copy uploaded before the original
// was flagged, whose scan has already run. Disabled until the one-off backfill
// at /api/admin/temp/minor-hash-sweep has been verified clean.
const ENABLED = false;

export const minorHashSweep = createJob('minor-hash-sweep', '45 3 * * *', async () => {
  if (!ENABLED) return;

  return await sweepMinorHashMatches({ dryRun: false, limit: 500 });
});
