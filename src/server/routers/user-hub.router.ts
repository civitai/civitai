import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getHubSourceSuggestionsSchema,
  resolveHubSourceSchema,
  setUserHubOrderSchema,
  upsertUserHubSchema,
} from '~/server/schema/user-hub.schema';
import {
  deleteUserHub,
  getUserHubById,
  getHubSourceSuggestions,
  getUserHubs,
  resolveHubSourceFromUrl,
  setUserHubOrder,
  upsertUserHub,
} from '~/server/services/user-hub.service';
import { router, userHubProcedure } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const userHubRouter = router({
  getAll: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserHubs({ userId: ctx.user.id })),
  getById: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getUserHubById({ id: input.id, userId: ctx.user.id })),
  upsert: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(upsertUserHubSchema)
    .mutation(({ input, ctx }) => upsertUserHub({ ...input, userId: ctx.user.id })),
  delete: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => deleteUserHub({ id: input.id, userId: ctx.user.id })),
  sourceSuggestions: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getHubSourceSuggestionsSchema)
    .query(({ input, ctx }) => getHubSourceSuggestions({ ...input, userId: ctx.user.id })),
  resolveSource: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(resolveHubSourceSchema)
    .query(({ input, ctx }) =>
      resolveHubSourceFromUrl({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
  setOrder: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setUserHubOrderSchema)
    .mutation(({ input, ctx }) => setUserHubOrder({ ...input, userId: ctx.user.id })),
});
