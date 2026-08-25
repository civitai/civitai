import {
  createBlurbHandler,
  deleteBlurbHandler,
  getMyBlurbsHandler,
  updateBlurbHandler,
} from '~/server/controllers/blurb.controller';
import {
  createBlurbInputSchema,
  deleteBlurbInputSchema,
  updateBlurbInputSchema,
} from '~/server/schema/blurb.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const blurbRouter = router({
  getMine: protectedProcedure.query(getMyBlurbsHandler),
  create: protectedProcedure.input(createBlurbInputSchema).mutation(createBlurbHandler),
  update: protectedProcedure.input(updateBlurbInputSchema).mutation(updateBlurbHandler),
  delete: protectedProcedure.input(deleteBlurbInputSchema).mutation(deleteBlurbHandler),
});
