import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import {
  ARTICLES_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { inJobContext } from '~/server/jobs/job';
import {
  articlesSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
  usersSearchIndex,
} from '~/server/search-index';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

export const schema = z.object({
  updateIds: commaDelimitedNumberArray().optional(),
  deleteIds: commaDelimitedNumberArray().optional(),
  index: z.enum([
    MODELS_SEARCH_INDEX,
    USERS_SEARCH_INDEX,
    IMAGES_SEARCH_INDEX,
    ARTICLES_SEARCH_INDEX,
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

    if (!data.length) {
      throw new Error('No ids provided');
    }

    await inJobContext(res, async (jobContext) => {
      switch (input.index) {
        case USERS_SEARCH_INDEX:
          await usersSearchIndex.updateSync(data, jobContext);
          break;
        case MODELS_SEARCH_INDEX:
          await modelsSearchIndex.updateSync(data, jobContext);
          break;
        case IMAGES_SEARCH_INDEX:
          await imagesSearchIndex.updateSync(data, jobContext);
          break;
        case ARTICLES_SEARCH_INDEX:
          await articlesSearchIndex.updateSync(data, jobContext);
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
