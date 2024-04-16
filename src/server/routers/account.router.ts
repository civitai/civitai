import { z } from 'zod';

import {
  deleteAccountHandler,
  getUserAccountsHandler,
} from '~/server/controllers/account.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const accountRouter = router({
  getAll: protectedProcedure.query(getUserAccountsHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteAccountHandler),
});
