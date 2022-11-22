import {
  deleteUserHandler,
  getAllUsersHandler,
  getUserByIdHandler,
  getUserStatsHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllUsersInput,
  getUserByUsernameSchema,
  userUpsertSchema,
} from '~/server/schema/user.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userRouter = router({
  getStats: publicProcedure.input(getUserByUsernameSchema).query(getUserStatsHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  update: protectedProcedure.input(userUpsertSchema.partial()).mutation(updateUserHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteUserHandler),
});
