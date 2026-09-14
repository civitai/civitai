import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { inJobContext } from '~/server/jobs/job';
import {
  articlesSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  usersSearchIndex,
  imagesMetricsSearchIndex,
  collectionsSearchIndex,
  bountiesSearchIndex,
  toolsSearchIndex,
  comicsSearchIndex,
} from '~/server/search-index';
import type { SearchIndexUpdateSyncResult } from '~/server/search-index/base.search-index';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedEnumArray, commaDelimitedNumberArray } from '~/utils/zod-helpers';

const searchIndexes = {
  [MODELS_SEARCH_INDEX]: modelsSearchIndex,
  [USERS_SEARCH_INDEX]: usersSearchIndex,
  [IMAGES_SEARCH_INDEX]: imagesSearchIndex,
  [ARTICLES_SEARCH_INDEX]: articlesSearchIndex,
  [METRICS_IMAGES_SEARCH_INDEX]: imagesMetricsSearchIndex,
  [COLLECTIONS_SEARCH_INDEX]: collectionsSearchIndex,
  [BOUNTIES_SEARCH_INDEX]: bountiesSearchIndex,
  [TOOLS_SEARCH_INDEX]: toolsSearchIndex,
  [COMICS_SEARCH_INDEX]: comicsSearchIndex,
};

export const schema = z.object({
  updateIds: commaDelimitedNumberArray().optional(),
  deleteIds: commaDelimitedNumberArray().optional(),
  processQueues: commaDelimitedEnumArray(['update', 'delete']).optional(),
  index: z.enum([
    MODELS_SEARCH_INDEX,
    USERS_SEARCH_INDEX,
    IMAGES_SEARCH_INDEX,
    ARTICLES_SEARCH_INDEX,
    METRICS_IMAGES_SEARCH_INDEX,
    COLLECTIONS_SEARCH_INDEX,
    BOUNTIES_SEARCH_INDEX,
    TOOLS_SEARCH_INDEX,
    COMICS_SEARCH_INDEX,
  ] as const satisfies ReadonlyArray<keyof typeof searchIndexes>),
});
export default ModEndpoint(async function updateIndexSync(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const input = schema.parse(req.query);

    const data = [
      ...(input.updateIds ?? []).map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
      ...(input.deleteIds ?? []).map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete })),
    ];

    if (!data.length && !input.processQueues?.length) {
      throw new Error('No ids provided');
    }

    let syncResult: SearchIndexUpdateSyncResult | undefined;

    await inJobContext(res, async (jobContext) => {
      const processQueuesOpts =
        (input.processQueues?.length ?? 0) > 0
          ? {
              processUpdates: input.processQueues?.includes('update'),
              processDeletes: input.processQueues?.includes('delete'),
            }
          : undefined;

      // `input.index` is constrained to the keys of `searchIndexes` by the zod enum above, which
      // is itself checked against those keys — so this lookup cannot miss.
      const searchIndex = searchIndexes[input.index];

      if (processQueuesOpts) {
        await searchIndex.processQueues(processQueuesOpts, jobContext);
      } else {
        syncResult = await searchIndex.updateSync(data, jobContext);
      }
    });

    // A batch that exhausted its retries indexed nothing. Returning 200 here is what made a
    // failed backfill indistinguishable from a successful one for the caller.
    if (syncResult && syncResult.failedTasks > 0) {
      res.status(500).send({
        status: 'error',
        index: syncResult.indexName,
        failedTasks: syncResult.failedTasks,
        totalTasks: syncResult.totalTasks,
        failedIds: syncResult.failedIds,
        error: `${syncResult.failedIds} ids in ${syncResult.failedTasks} of ${syncResult.totalTasks} batches failed to index`,
      });
      return;
    }

    res.status(200).send({ status: 'ok' });
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
