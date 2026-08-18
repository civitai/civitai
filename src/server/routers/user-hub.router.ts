import { getByIdSchema } from '~/server/schema/base.schema';
import { setUserHubOrderSchema, upsertUserHubSchema } from '~/server/schema/user-hub.schema';
import {
  deleteUserHub,
  getUserHubById,
  getUserHubs,
  setUserHubOrder,
  upsertUserHub,
} from '~/server/services/user-hub.service';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const userHubRouter = router({
  getAll: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserHubs({ userId: ctx.user.id })),
  getById: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getUserHubById({ id: input.id, userId: ctx.user.id })),
  upsert: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(upsertUserHubSchema)
    .mutation(({ input, ctx }) => upsertUserHub({ ...input, userId: ctx.user.id })),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => deleteUserHub({ id: input.id, userId: ctx.user.id })),
  setOrder: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setUserHubOrderSchema)
    .mutation(({ input, ctx }) => setUserHubOrder({ ...input, userId: ctx.user.id })),
});
