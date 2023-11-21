import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import {
  addEntityToShowcaseHandler,
  getUserContentOverviewHandler,
  getUserProfileHandler,
  updateUserProfileHandler,
} from '~/server/controllers/user-profile.controller';
import {
  getUserProfileSchema,
  showcaseItemSchema,
  userProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';

export const userProfileRouter = router({
  get: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserProfileHandler),
  overview: publicProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(getUserProfileSchema)
    .query(getUserContentOverviewHandler),
  update: guardedProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(userProfileUpdateSchema)
    .mutation(updateUserProfileHandler),
  addEntityToShowcase: protectedProcedure
    .use(isFlagProtected('profileOverhaul'))
    .input(showcaseItemSchema)
    .mutation(addEntityToShowcaseHandler),
});
