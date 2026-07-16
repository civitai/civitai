import { CacheTTL } from '~/server/common/constants';
import { applyRequestDomainColor, edgeCacheIt } from '~/server/middleware.trpc';
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const changelogRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getChangelogsInput)
    .use(applyRequestDomainColor)
    .query(({ input, ctx }) =>
      getChangelogs({
        ...input,
        hasFeature: ctx.features.changelogEdit,
      })
    ),
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
  getAllTags: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getChangelogsInput.pick({ domain: true }).default({}))
    .use(applyRequestDomainColor)
    .query(({ input }) => getAllTags(input)),
  getLatest: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getChangelogsInput.pick({ domain: true }).default({}))
    .use(applyRequestDomainColor)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getLatestChangelog(input)),
});
