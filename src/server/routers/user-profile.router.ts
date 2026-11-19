import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import {
  addEntityToShowcaseHandler,
  addToShowcaseSectionHandler,
  getUserContentOverviewHandler,
  getUserProfileHandler,
  setShowcaseSectionsHandler,
  updateUserProfileHandler,
} from '~/server/controllers/user-profile.controller';
import {
  addToShowcaseSectionSchema,
  getUserProfileSchema,
  setShowcaseSectionsSchema,
  showcaseItemSchema,
  userProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const userProfileRouter = router({
  get: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserProfileSchema)
    .query(getUserProfileHandler),
  overview: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserProfileSchema)
    .query(getUserContentOverviewHandler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userProfileUpdateSchema)
    .mutation(updateUserProfileHandler),
  addEntityToShowcase: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(showcaseItemSchema)
    .mutation(addEntityToShowcaseHandler),
  setShowcaseSections: protectedProcedure
    .use(isFlagProtected('profileShowcases'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setShowcaseSectionsSchema)
    .mutation(setShowcaseSectionsHandler),
  addToShowcaseSection: protectedProcedure
    .use(isFlagProtected('profileShowcases'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(addToShowcaseSectionSchema)
    .mutation(addToShowcaseSectionHandler),
});
