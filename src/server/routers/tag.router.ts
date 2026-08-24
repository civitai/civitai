import { CacheTTL } from '~/server/common/constants';
import {
  addTagsHandler,
  addTagVotesHandler,
  getAllTagsHandler,
  getTagWithModelCountHandler,
  getTrendingTagsHandler,
  getVotableTagsHandler,
  removeTagVotesHandler,
  disableTagsHandler,
  getManagableTagsHandler,
  deleteTagsHandler,
  getHomeExcludedTagsHandler,
} from '~/server/controllers/tag.controller';
import { applyUserPreferences, cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import type { UserPreferencesInput } from '~/server/schema/base.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import type { GetTagsInput } from '~/server/schema/tag.schema';
import {
  addTagVotesSchema,
  adjustTagsSchema,
  deleteTagsSchema,
  getTagByNameSchema,
  getTagsInput,
  getTrendingTagsSchema,
  getVotableTagsSchema,
  removeTagVotesSchema,
} from '~/server/schema/tag.schema';
import { FEED_TAG_BAR_EDGE_TAG, getTag } from '~/server/services/tag.service';
import { getFeedTagBarTags } from '~/server/services/system-cache';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input }) => getTag(input)),
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTagsInput.optional())
    .use(applyUserPreferences)
    .use(
      // applyUserPreferences injects four id lists; getTags reads only
      // excludedTagIds. Hashing the other three cost up to 213ms of synchronous
      // event-loop block per request for accounts with large hidden sets.
      cacheIt<GetTagsInput & UserPreferencesInput>({
        ttl: 60,
        excludeKeys: ['excludedImageIds', 'excludedUserIds', 'excludedModelIds'],
        varyBy: (ctx) => ({ adminTags: ctx.features.adminTags }),
      })
    )
    .query(getAllTagsHandler),
  // No input: the chip set is server-owned (see feed-tag-bar.constants), which is
  // what keeps this edge-cacheable for everyone and keeps a caller from widening it.
  getFeedTagBar: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(edgeCacheIt({ ttl: CacheTTL.hour, tags: () => [FEED_TAG_BAR_EDGE_TAG] }))
    .query(() => getFeedTagBarTags()),
  getHomeExcluded: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(edgeCacheIt({ ttl: 24 * 60 * 60 }))
    .query(getHomeExcludedTagsHandler),
  getTrending: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getTrendingTagsSchema)
    .use(applyUserPreferences)
    .query(getTrendingTagsHandler),
  getManagableTags: moderatorProcedure.query(getManagableTagsHandler),
  getVotableTags: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getVotableTagsSchema)
    .query(getVotableTagsHandler),
  addTagVotes: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(addTagVotesSchema)
    .mutation(addTagVotesHandler),
  removeTagVotes: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(removeTagVotesSchema)
    .mutation(removeTagVotesHandler),
  addTags: moderatorProcedure.input(adjustTagsSchema).mutation(addTagsHandler),
  disableTags: moderatorProcedure.input(adjustTagsSchema).mutation(disableTagsHandler),
  deleteTags: moderatorProcedure.input(deleteTagsSchema).mutation(deleteTagsHandler),
});
