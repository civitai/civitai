import {
  createFolderHandler,
  getProfileFoldersHandler,
  setFolderRowsHandler,
  setItemShowcaseHandler,
} from '~/server/controllers/profile-folders.controller';
import {
  createFolderInput,
  getProfileFoldersInput,
  setFolderRowsInput,
  setItemShowcaseInput,
} from '~/server/schema/profile-folders.schema';
import { guardedProcedure, isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const profileFoldersRouter = router({
  getAll: publicProcedure
    .use(isFlagProtected('profileFolders'))
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getProfileFoldersInput)
    .query(getProfileFoldersHandler),
  create: guardedProcedure
    .use(isFlagProtected('profileFolders'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(createFolderInput)
    .mutation(createFolderHandler),
  setItemShowcase: guardedProcedure
    .use(isFlagProtected('profileFolders'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setItemShowcaseInput)
    .mutation(setItemShowcaseHandler),
  setRows: guardedProcedure
    .use(isFlagProtected('profileFolders'))
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setFolderRowsInput)
    .mutation(setFolderRowsHandler),
});
