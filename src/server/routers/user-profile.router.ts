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
  get: publicProcedure.input(getUserProfileSchema).query(getUserProfileHandler),
  overview: publicProcedure.input(getUserProfileSchema).query(getUserContentOverviewHandler),
  update: guardedProcedure.input(userProfileUpdateSchema).mutation(updateUserProfileHandler),
  addEntityToShowcase: protectedProcedure
    .input(showcaseItemSchema)
    .mutation(addEntityToShowcaseHandler),
});
