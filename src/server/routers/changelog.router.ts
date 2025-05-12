import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  createChangelogInput,
  getChangelogsInput,
  updateChangelogInput,
} from '~/server/schema/changelog.schema';
import {
  createChangelog,
  getAllTags,
  getChangelogs,
  getLatestChangelog,
  updateChangelog,
} from '~/server/services/changelog.service';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';

export const changelogRouter = router({
  getInfinite: publicProcedure
    .input(getChangelogsInput)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input, ctx }) => getChangelogs({ ...input, isModerator: ctx.user?.isModerator })),
  create: moderatorProcedure
    .input(createChangelogInput)
    .mutation(({ input }) => createChangelog(input)),
  update: moderatorProcedure
    .input(updateChangelogInput)
    .mutation(({ input }) => updateChangelog(input)),
  getAllTags: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getAllTags()),
  getLatest: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getLatestChangelog()),
});
