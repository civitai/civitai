import { getUserCreatorHandler } from './../controllers/user.controller';
import {
  deleteUserHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getUserByIdHandler,
  getUserFavoriteModelsHandler,
  toggleFavoriteModelHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllUsersInput,
  getUserByUsernameSchema,
  toggleFavoriteModelInput,
  userUpsertSchema,
} from '~/server/schema/user.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userRouter = router({
  getCreator: publicProcedure.input(getUserByUsernameSchema).query(getUserCreatorHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  getFavoriteModels: protectedProcedure.query(getUserFavoriteModelsHandler),
  getCreators: publicProcedure.input(getAllQuerySchema.partial()).query(getCreatorsHandler),
  update: protectedProcedure.input(userUpsertSchema.partial()).mutation(updateUserHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteUserHandler),
  toggleFavorite: protectedProcedure
    .input(toggleFavoriteModelInput)
    // .use(isOwner)
    .mutation(toggleFavoriteModelHandler),
});
