import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  getUserContentOverviewHandler,
  getUserProfileHandler,
  updateUserProfileHandler,
} from '~/server/controllers/user-profile.controller';
import { getUserProfileSchema, userProfileUpdateSchema } from '~/server/schema/user-profile.schema';

export const userProfileRouter = router({
  get: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserProfileHandler),
  overview: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserContentOverviewHandler),
  update: protectedProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(userProfileUpdateSchema)
    .mutation(updateUserProfileHandler),
});
