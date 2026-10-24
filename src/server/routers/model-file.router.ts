import {
  createFileHandler,
  deleteFileHandler,
  hasOfficialFileOfSizeHandler,
  getFilesByVersionIdHandler,
  restoreReplacedFileHandler,
  updateFileHandler,
  upsertFileHandler,
} from '~/server/controllers/model-file.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  hasOfficialFileOfSizeSchema,
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
import { dbRead } from '~/server/db/client';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { ownerOnlyFileUrls, withoutFileUrls } from '~/server/utils/owner-only-file-urls';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const fileUrlsForOwner = ownerOnlyFileUrls<
  Awaited<ReturnType<typeof getFilesByVersionIdHandler>>,
  { id: number }
>({
  ownerId: async ({ input }) =>
    (
      await dbRead.modelVersion.findUnique({
        where: { id: input.id },
        select: { model: { select: { userId: true } } },
      })
    )?.model.userId,
  strip: (data) => data && { ...data, files: withoutFileUrls(data.files) as typeof data.files },
});

export const modelFileRouter = router({
  getByVersionId: publicProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(getByIdSchema)
    .use(fileUrlsForOwner)
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
  restoreReplaced: moderatorProcedure
    .meta({ requiredScope: TokenScope.ModelsWrite })
    .input(getByIdSchema)
    .mutation(restoreReplacedFileHandler),
  getRecentTrainingData: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(recentTrainingDataSchema)
    .query(({ input, ctx }) => getRecentTrainingData({ ...input, userId: ctx.user.id })),
  hasOfficialFileOfSize: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(hasOfficialFileOfSizeSchema)
    .query(hasOfficialFileOfSizeHandler),
});
