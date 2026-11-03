import { noEdgeCache } from '~/server/middleware.trpc';
import { getExperimentAssignments } from '~/server/services/experiments.service';
import { protectedProcedure, router } from '~/server/trpc';
import { EXPERIMENT_OVERRIDE_COOKIE } from '~/shared/constants/experiments.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const experimentsRouter = router({
  getAssignments: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(noEdgeCache())
    .query(({ ctx }) =>
      getExperimentAssignments({
        user: ctx.user,
        overrideCookie: ctx.req?.cookies?.[EXPERIMENT_OVERRIDE_COOKIE],
      })
    ),
});
