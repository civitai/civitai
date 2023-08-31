import {
  createFileHandler,
  deleteFileHandler,
  getFilesByVersionIdHandler,
  updateFileHandler,
  upsertFileHandler,
} from '~/server/controllers/model-file.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  modelFileCreateSchema,
  modelFileUpdateSchema,
  modelFileUpsertSchema,
} from '~/server/schema/model-file.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const modelFileRouter = router({
  getByVersionId: publicProcedure.input(getByIdSchema).query(getFilesByVersionIdHandler),
  create: protectedProcedure.input(modelFileCreateSchema).mutation(createFileHandler),
  update: protectedProcedure.input(modelFileUpdateSchema).mutation(updateFileHandler),
  upsert: protectedProcedure.input(modelFileUpsertSchema).mutation(upsertFileHandler),
  delete: protectedProcedure.input(getByIdSchema).mutation(deleteFileHandler),
  // deleteMany: protectedProcedure.input(deleteApiKeyInputSchema).mutation(deleteApiKeyHandler),
});
