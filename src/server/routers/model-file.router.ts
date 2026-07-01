import {
  createFileHandler,
  deleteFileHandler,
  findOfficialFilesBySizeHandler,
  getFilesByVersionIdHandler,
  updateFileHandler,
  upsertFileHandler,
} from '~/server/controllers/model-file.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  findOfficialFilesBySizeSchema,
  modelFileCreateSchema,
  modelFileUpdateSchema,
  modelFileUpsertSchema,
  recentTrainingDataSchema,
} from '~/server/schema/model-file.schema';
import {
  getModelFileOptions,
  getRecentTrainingData,
  MODEL_FILE_OPTIONS_EDGE_TAG,
} from '~/server/services/model-file.service';
import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const modelFileRouter = router({
  getByVersionId: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .query(getFilesByVersionIdHandler),
  getOptions: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .use(edgeCacheIt({ ttl: CacheTTL.sm, tags: () => [MODEL_FILE_OPTIONS_EDGE_TAG] }))
    .query(() => getModelFileOptions()),
  create: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(modelFileCreateSchema)
    .mutation(createFileHandler),
  update: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(modelFileUpdateSchema)
    .mutation(updateFileHandler),
  upsert: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(modelFileUpsertSchema)
    .mutation(upsertFileHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsDelete })
    .input(getByIdSchema)
    .mutation(deleteFileHandler),
  // deleteMany: protectedProcedure.input(deleteApiKeyInputSchema).mutation(deleteApiKeyHandler),
  getRecentTrainingData: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(recentTrainingDataSchema)
    .query(({ input, ctx }) => getRecentTrainingData({ ...input, userId: ctx.user.id })),
  findOfficialFilesBySize: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(findOfficialFilesBySizeSchema)
    .query(({ input }) => findOfficialFilesBySizeHandler(input)),
});
