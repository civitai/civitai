import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { getUserProfileHandler } from '~/server/controllers/user-profile.controller';
import { getUserProfileSchema } from '~/server/schema/user-profile.schema';

export const userProfileRouter = router({
  get: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserProfileHandler),
});
