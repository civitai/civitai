import * as z from 'zod';
import { constants, IMAGE_IDS_BATCH_MAX } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { keysetCursorSchema } from '~/server/schema/base.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';
import {
  nsfwBrowsingLevelsFlag,
  NsfwLevelDeprecated,
  nsfwLevelMapDeprecated,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { usernameSchema } from '~/shared/zod/username.schema';
import {
  booleanString,
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';

// The `/api/v1/images` query (src/pages/api/v1/images/index.ts parses `req.query` with it). In its own
// module so scripts/feed-go-input-schemas.ts can project it without loading the route's handler.
// TODO merge with getInfiniteImagesSchema
export const imagesEndpointSchema = z.object({
  limit: numericString(z.number().min(0).max(200)).default(constants.galleryFilterDefaults.limit),
  page: numericString().optional(),
  postId: numericString().optional(),
  modelId: numericString().optional(),
  modelVersionId: numericString().optional(),
  imageId: numericString().optional(),
  // Batch by id — `?ids=1,2,3`. The one-round-trip replacement for the retired
  // `GET_IMAGES_BY_IDS` bridge message, which was batch by construction; without
  // it a 50-cell grid is 50 requests against a rate-limited public API
  // (civitai/civitai-app-starters#429).
  //
  // 🔴 Three properties a caller must not assume away:
  //   1. RESULTS ARE A SUBSET. An id the viewer may not see and an id that does
  //      not exist are BOTH simply absent — deliberately indistinguishable. See
  //      the note above `handleImagesRequest`.
  //   2. ORDER IS `sort`, NOT REQUEST ORDER. The filter is a SQL
  //      `i."id" = ANY(...)`; re-key by `item.id` client-side.
  //   3. `ids` FORCES THE LEGACY DB PATH (image-search.service.ts). Meili feed
  //      search builds no id filter and would answer with the global feed.
  // `.min(1)` because an empty array is not a batch — it would fall through
  // every id clause and return the unfiltered feed.
  ids: commaDelimitedNumberArray(
    z.number().int().positive().array().min(1).max(IMAGE_IDS_BATCH_MAX)
  ).optional(),
  username: usernameSchema.optional(),
  userId: numericString().optional(),
  period: z.enum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.enum(ImageSort).default(constants.galleryFilterDefaults.sort),
  nsfw: z
    .union([z.enum(NsfwLevelDeprecated), booleanString()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value === 'boolean')
        return value ? nsfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
      return nsfwLevelMapDeprecated[value] as number;
    }),
  // A bit mask. A fraction or a value past int32 would otherwise fail inside the search, as a 503.
  browsingLevel: z.coerce.number().int().min(0).max(2147483647).optional(),
  tags: commaDelimitedNumberArray().optional(),
  cursor: keysetCursorSchema.optional(),
  type: z.enum(MediaType).optional(),
  baseModels: commaDelimitedEnumArray([...baseModels]).optional(),
  withMeta: booleanString().default(false),
  requiringMeta: booleanString().optional(),
  flatMeta: booleanString().optional(),
  withTags: booleanString().default(false),
});
