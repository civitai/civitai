import {
  createFileHandler,
  deleteFileHandler,
  getFilesByVersionIdHandler,
} from '~/server/controllers/model-file.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import { modelFileCreateSchema } from '~/server/schema/model-file.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const modelFileRouter = router({
  getByVersionId: publicProcedure.input(getByIdSchema).query(getFilesByVersionIdHandler),
  create: protectedProcedure.input(modelFileCreateSchema).mutation(createFileHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteFileHandler),
  // deleteMany: protectedProcedure.input(deleteApiKeyInputSchema).mutation(deleteApiKeyHandler),
});
