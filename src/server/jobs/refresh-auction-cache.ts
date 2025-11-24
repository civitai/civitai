import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { modelVersionResourceCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { bustFeaturedModelsCache } from '~/server/services/model.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

export const refreshAuctionCache = createJob('refresh-auction-cache', '6 0 * * *', async () => {
  const data = await dbWrite.coveredCheckpoint.findMany();

  if (!data.length) return;

  const versionIds = data.map((c) => c.version_id);

  await modelsSearchIndex.updateSync(
    data.map((c) => ({ id: c.model_id, action: SearchIndexUpdateQueueAction.Update }))
  );
  await bustFeaturedModelsCache();
  await homeBlockCacheBust(HomeBlockType.FeaturedModelVersion, 'default');
  await resourceDataCache.bust(versionIds);
  await modelVersionResourceCache.bust(versionIds);
  await bustOrchestratorModelCache(versionIds);
});
