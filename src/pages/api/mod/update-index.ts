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
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedEnumArray, commaDelimitedNumberArray } from '~/utils/zod-helpers';

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
  ]),
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

    await inJobContext(res, async (jobContext) => {
      const processQueuesOpts =
        (input.processQueues?.length ?? 0) > 0
          ? {
              processUpdates: input.processQueues?.includes('update'),
              processDeletes: input.processQueues?.includes('delete'),
            }
          : undefined;

      switch (input.index) {
        case USERS_SEARCH_INDEX:
          if (processQueuesOpts) {
            await usersSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await usersSearchIndex.updateSync(data, jobContext);
          }
          break;
        case MODELS_SEARCH_INDEX:
          if (processQueuesOpts) {
            await modelsSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await modelsSearchIndex.updateSync(data, jobContext);
          }
          break;
        case IMAGES_SEARCH_INDEX:
          if (processQueuesOpts) {
            await imagesSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await imagesSearchIndex.updateSync(data, jobContext);
          }
          break;
        case ARTICLES_SEARCH_INDEX:
          if (processQueuesOpts) {
            await articlesSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await articlesSearchIndex.updateSync(data, jobContext);
          }
          break;
        case METRICS_IMAGES_SEARCH_INDEX:
          if (processQueuesOpts) {
            await imagesMetricsSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await imagesMetricsSearchIndex.updateSync(data, jobContext);
          }
          break;
        case COLLECTIONS_SEARCH_INDEX:
          if (processQueuesOpts) {
            await collectionsSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await collectionsSearchIndex.updateSync(data, jobContext);
          }
          break;
        case BOUNTIES_SEARCH_INDEX:
          if (processQueuesOpts) {
            await bountiesSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await bountiesSearchIndex.updateSync(data, jobContext);
          }
          break;
        case TOOLS_SEARCH_INDEX:
          if (processQueuesOpts) {
            await toolsSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await toolsSearchIndex.updateSync(data, jobContext);
          }
          break;
        case COMICS_SEARCH_INDEX:
          if (processQueuesOpts) {
            await comicsSearchIndex.processQueues(processQueuesOpts, jobContext);
          } else {
            await comicsSearchIndex.updateSync(data, jobContext);
          }
          break;
        default:
          break;
      }
    });

    res.status(200).send({ status: 'ok' });
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
