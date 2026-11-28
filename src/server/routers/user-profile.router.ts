import { guardedProcedure, isFlagProtected, publicProcedure, router } from '~/server/trpc';
import {
  addEntityToShowcaseHandler,
  addToShowcaseSectionHandler,
  getProfileAboutHandler,
  getProfileCustomizationHandler,
  getUserContentOverviewHandler,
  getUserProfileHandler,
  setShowcaseSectionsHandler,
  setPinnedItemHandler,
  setProfileBackgroundHandler,
  updateUserProfileHandler,
} from '~/server/controllers/user-profile.controller';
import {
  addToShowcaseSectionSchema,
  getProfileCustomizationSchema,
  getProfilePartSchema,
  getUserProfileSchema,
  setPinnedItemSchema,
  setProfileBackgroundSchema,
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
  customization: publicProcedure
    .use(isFlagProtected('profileRedesign'))
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getProfileCustomizationSchema)
    .query(getProfileCustomizationHandler),
  about: publicProcedure
    .use(isFlagProtected('profileRedesign'))
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getProfilePartSchema)
    .query(getProfileAboutHandler),
  setBackground: guardedProcedure
    .use(isFlagProtected('profileRedesign'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setProfileBackgroundSchema)
    .mutation(setProfileBackgroundHandler),
  setPinned: guardedProcedure
    .use(isFlagProtected('profileRedesign'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setPinnedItemSchema)
    .mutation(setPinnedItemHandler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userProfileUpdateSchema)
    .mutation(updateUserProfileHandler),
  addEntityToShowcase: guardedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(showcaseItemSchema)
    .mutation(addEntityToShowcaseHandler),
  setShowcaseSections: guardedProcedure
    .use(isFlagProtected('profileShowcases'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setShowcaseSectionsSchema)
    .mutation(setShowcaseSectionsHandler),
  addToShowcaseSection: guardedProcedure
    .use(isFlagProtected('profileShowcases'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(addToShowcaseSectionSchema)
    .mutation(addToShowcaseSectionHandler),
});
