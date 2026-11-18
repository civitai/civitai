import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

// The feeds index (`metrics_images_v1`) lived on the feeds Meilisearch instance, which is retired
// and deleted; the image feed is served by the feed service. This processor is kept only because
// many services still call `imagesMetricsSearchIndex.queueUpdate`, and as a retired processor every
// write and sync path is a no-op (see `retired` in base.search-index.ts). It holds no client, so it
// cannot write to any Meilisearch instance.
export const imagesMetricsDetailsSearchIndex = createSearchIndexUpdateProcessor({
  retired: true,
  indexName: INDEX_ID,
  setup: async () => undefined,
  prepareBatches: async () => ({ batchSize: 0, startId: 0, endId: 0, updateIds: [] }),
  pullData: async () => null,
  transformData: async (data: unknown) => data,
  pushData: async () => undefined,
});
