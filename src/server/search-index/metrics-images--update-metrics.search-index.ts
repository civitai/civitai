import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

// The metrics refresh for the retired feeds index. A no-op kept for its job registration; see
// metrics-images.search-index.ts.
export const imagesMetricsDetailsSearchIndexUpdateMetrics = createSearchIndexUpdateProcessor({
  retired: true,
  indexName: INDEX_ID,
  jobName: `${INDEX_ID}_metrics`,
  partial: true,
  setup: async () => undefined,
  prepareBatches: async () => ({ batchSize: 0, startId: 0, endId: 0, updateIds: [] }),
  pullData: async () => null,
  transformData: async (data: unknown) => data,
  pushData: async () => undefined,
});
