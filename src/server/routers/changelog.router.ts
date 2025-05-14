import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  createChangelogInput,
  deleteChangelogInput,
  getChangelogsInput,
  updateChangelogInput,
} from '~/server/schema/changelog.schema';
import {
  createChangelog,
  deleteChangelog,
  getAllTags,
  getChangelogs,
  getLatestChangelog,
  updateChangelog,
} from '~/server/services/changelog.service';
import { isFlagProtected, moderatorProcedure, publicProcedure, router } from '~/server/trpc';

export const changelogRouter = router({
  getInfinite: publicProcedure
    .input(getChangelogsInput)
    .query(({ input, ctx }) => getChangelogs({ ...input, hasFeature: ctx.features.changelogEdit })),
  create: moderatorProcedure
    .input(createChangelogInput)
    .use(isFlagProtected('changelogEdit'))
    .mutation(({ input }) => createChangelog(input)),
  update: moderatorProcedure
    .input(updateChangelogInput)
    .use(isFlagProtected('changelogEdit'))
    .mutation(({ input }) => updateChangelog(input)),
  delete: moderatorProcedure
    .input(deleteChangelogInput)
    .use(isFlagProtected('changelogEdit'))
    .mutation(({ input }) => deleteChangelog(input)),
  getAllTags: publicProcedure.query(() => getAllTags()),
  getLatest: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getLatestChangelog()),
});
