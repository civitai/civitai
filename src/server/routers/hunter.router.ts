import {
  addApiKeyInputSchema,
  deleteApiKeyInputSchema,
  getUserApiKeysInputSchema,
} from '~/server/schema/api-key.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const hunterRouter = router({
  getAll: publicProcedure.input(getUserApiKeysInputSchema).query(() => ({})),
  add: protectedProcedure.input(addApiKeyInputSchema).mutation(() => ({})),
  update: protectedProcedure.input(addApiKeyInputSchema).mutation(() => ({})),
  delete: protectedProcedure.input(deleteApiKeyInputSchema).mutation(() => ({})),
});
