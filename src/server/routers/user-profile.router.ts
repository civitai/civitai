import { publicProcedure, router } from '~/server/trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import { getUserProfileHandler } from '~/server/controllers/user-profile.controller';

export const userProfileRouter = router({
  get: publicProcedure.input(getByIdSchema).query(getUserProfileHandler),
});
