import { getByIdSchema } from '~/server/schema/base.schema';
import {
  addUserHubSourceSchema,
  getHubSourceSuggestionsSchema,
  resolveHubSourceSchema,
  setUserHubOrderSchema,
  upsertUserHubSchema,
  userHubSourceRefSchema,
} from '~/server/schema/user-hub.schema';
import {
  addUserHubSource,
  deleteUserHub,
  getUserHubById,
  getHubSourceSuggestions,
  getUserHubs,
  removeUserHubSource,
  resolveHubSourceFromUrl,
  setUserHubOrder,
  upsertUserHub,
} from '~/server/services/user-hub.service';
import { publicUserHubProcedure, router, userHubProcedure } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const userHubRouter = router({
  getAll: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserHubs({ userId: ctx.user.id })),
  getById: publicUserHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getUserHubById({
        id: input.id,
        userId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      })
    ),
  upsert: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(upsertUserHubSchema)
    .mutation(({ input, ctx }) => upsertUserHub({ ...input, userId: ctx.user.id })),
  addSource: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(addUserHubSourceSchema)
    .mutation(({ input, ctx }) => addUserHubSource({ ...input, userId: ctx.user.id })),
  removeSource: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userHubSourceRefSchema)
    .mutation(({ input, ctx }) => removeUserHubSource({ ...input, userId: ctx.user.id })),
  delete: userHubProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => deleteUserHub({ id: input.id, userId: ctx.user.id })),
  sourceSuggestions: userHubProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getHubSourceSuggestionsSchema)
    .query(({ input, ctx }) =>
      getHubSourceSuggestions({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
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
