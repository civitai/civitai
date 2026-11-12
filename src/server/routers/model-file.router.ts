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
import {
  trainingDataOwnerView,
  trainingDataPublicView,
  mayCarryEpochUrls,
  withoutEpochUrls,
} from '~/server/services/training-data-restricted.service';
import { isModelDeletedOrTakenDown } from '~/server/utils/model-withheld';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const fileUrlsForOwner = ownerOnlyFileUrls<
  Awaited<ReturnType<typeof getFilesByVersionIdHandler>>,
  { id: number }
>({
  ownerId: async ({ data, input }) => (await versionModel(data, input.id))?.userId,
  // A deleted or taken-down model's epoch urls are withheld from everyone but moderators.
  strip: async (data, { redCapable }) => {
    if (!data) return data;
    const view = await trainingDataPublicView(
      dbRead,
      [{ id: data.modelVersionId, files: data.files }],
      { redCapable }
    );
    const files = withoutFileUrls(view(data.files)) as typeof data.files;
    return { ...data, files: (await withheld(data)) ? withoutEpochUrls(files) : files };
  },
  forOwner: async (data) => {
    if (!data) return data;
    const files = trainingDataOwnerView(data.files);
    return { ...data, files: (await withheld(data)) ? withoutEpochUrls(files) : files };
  },
});

type VersionFiles = Awaited<ReturnType<typeof getFilesByVersionIdHandler>>;
// One read per response: the owner check and the view that follows share it.
const versionModelByResponse = new WeakMap<object, Promise<VersionModel | undefined>>();
type VersionModel = { userId: number; status: string; mode: string | null };

function versionModel(data: VersionFiles, modelVersionId: number) {
  const read = () =>
    dbRead.modelVersion
      .findUnique({
        where: { id: modelVersionId },
        select: { model: { select: { userId: true, status: true, mode: true } } },
      })
      .then((version) => version?.model);
  if (!data) return read();
  let pending = versionModelByResponse.get(data);
  if (!pending) {
    pending = read();
    versionModelByResponse.set(data, pending);
  }
  return pending;
}

async function withheld(data: NonNullable<VersionFiles>) {
  if (!mayCarryEpochUrls(data.files)) return false;
  const model = await versionModel(data, data.modelVersionId);
  return !!model && isModelDeletedOrTakenDown(model);
}

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
    .query(({ input, ctx }) =>
      getRecentTrainingData({
        ...input,
        userId: ctx.user.id,
        isModerator: !!ctx.user.isModerator,
      })
    ),
  hasOfficialFileOfSize: protectedProcedure
    .meta({ requiredScope: TokenScope.ModelsRead })
    .input(hasOfficialFileOfSizeSchema)
    .query(hasOfficialFileOfSizeHandler),
});
