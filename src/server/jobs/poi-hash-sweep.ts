import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { sweepPoiHashMatches } from '~/server/services/poi-hash.service';
import { createJob } from './job';

export const poiHashSweep = createJob('poi-hash-sweep', '15 4 * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.POI_HASH_AUTO_FLAG))) return;
  return sweepPoiHashMatches({ limit: 500 });
});
