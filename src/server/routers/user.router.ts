import {
  deleteUserHandler,
  getAllUsersHandler,
  getUserByIdHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { getAllUsersInput, userUpsertSchema } from '~/server/schema/user.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userRouter = router({
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  update: protectedProcedure.input(userUpsertSchema.partial()).mutation(updateUserHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteUserHandler),
});
