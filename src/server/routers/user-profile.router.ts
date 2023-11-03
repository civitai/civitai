import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {getUserProfileHandler, updateUserProfileHandler} from '~/server/controllers/user-profile.controller';
import { getUserProfileSchema, userProfileUpdateSchema } from '~/server/schema/user-profile.schema';

export const userProfileRouter = router({
  get: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserProfileHandler),
  update: protectedProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(userProfileUpdateSchema)
    .mutation(updateUserProfileHandler),
});
