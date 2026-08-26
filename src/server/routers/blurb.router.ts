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
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

const blurbProcedure = protectedProcedure.use(isFlagProtected('textBlurbs'));

export const blurbRouter = router({
  getMine: blurbProcedure.query(getMyBlurbsHandler),
  create: blurbProcedure.input(createBlurbInputSchema).mutation(createBlurbHandler),
  update: blurbProcedure.input(updateBlurbInputSchema).mutation(updateBlurbHandler),
  delete: blurbProcedure.input(deleteBlurbInputSchema).mutation(deleteBlurbHandler),
});
