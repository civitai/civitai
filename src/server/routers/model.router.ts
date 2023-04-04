import { z } from 'zod';

import { env } from '~/env/server.mjs';
import {
  createModelHandler,
  deleteModelHandler,
  getDownloadCommandHandler,
  getModelDetailsForReviewHandler,
  getModelHandler,
  getModelReportDetailsHandler,
  getModelsInfiniteHandler,
  getModelsPagedSimpleHandler,
  getModelsWithVersionsHandler,
  getModelVersionsHandler,
  getModelWithVersionsHandler,
  getMyDraftModelsHandler,
  publishModelHandler,
  reorderModelVersionsHandler,
  restoreModelHandler,
  unpublishModelHandler,
  updateModelHandler,
  upsertModelHandler,
} from '~/server/controllers/model.controller';
import { dbRead } from '~/server/db/client';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteModelSchema,
  GetAllModelsOutput,
  getAllModelsSchema,
  getDownloadSchema,
  ModelInput,
  modelSchema,
  modelUpsertSchema,
  publishModelSchema,
  reorderModelVersionsSchema,
} from '~/server/schema/model.schema';
import {
  guardedProcedure,
  middleware,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { checkFileExists, getS3Client } from '~/utils/s3-utils';
import { prepareFile } from '~/utils/file-helpers';
import { getAllHiddenForUser, getHiddenTagsForUser } from '~/server/services/user-cache.service';
import { BrowsingMode } from '~/server/common/enums';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.model.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
      ownerId,
    },
  });
});

const checkFilesExistence = middleware(async ({ input, ctx, next }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { modelVersions } = input as ModelInput;
  const files = modelVersions.flatMap(({ files }) => files?.map(prepareFile) ?? []);
  const s3 = getS3Client();

  for (const file of files) {
    if (!file.url || !file.url.includes(env.S3_UPLOAD_BUCKET)) continue;
    const fileExists = await checkFileExists(file.url, s3);
    if (!fileExists)
      throw throwBadRequestError(`File ${file.name} could not be found. Please re-upload.`, {
        file,
      });
  }

  return next({
    ctx: { user: ctx.user },
  });
});

const applyUserPreferences = middleware(async ({ input, ctx, next }) => {
  if (ctx.browsingMode !== BrowsingMode.All) {
    const _input = input as GetAllModelsOutput;
    _input.browsingMode = ctx.browsingMode;
    const hidden = await getAllHiddenForUser({ userId: ctx.user?.id });
    _input.excludedImageTagIds = [
      ...hidden.tags.moderatedTags,
      ...hidden.tags.hiddenTags,
      ...(_input.excludedImageTagIds ?? []),
    ];
    _input.excludedTagIds = [...hidden.tags.hiddenTags, ...(_input.excludedTagIds ?? [])];
    _input.excludedIds = [...hidden.models, ...(_input.excludedIds ?? [])];
    _input.excludedUserIds = [...hidden.users, ...(_input.excludedUserIds ?? [])];
    _input.excludedImageIds = [...hidden.images, ...(_input.excludedImageIds ?? [])];
    if (ctx.browsingMode === BrowsingMode.SFW) {
      const systemHidden = await getHiddenTagsForUser({ userId: -1 });
      _input.excludedImageTagIds = [
        ...systemHidden.moderatedTags,
        ...systemHidden.hiddenTags,
        ...(_input.excludedImageTagIds ?? []),
      ];
      _input.excludedTagIds = [...systemHidden.hiddenTags, ...(_input.excludedTagIds ?? [])];
    }
  }

  return next({
    ctx: { user: ctx.user },
  });
});

export const modelRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getModelHandler),
  getAll: publicProcedure
    .input(getAllModelsSchema.extend({ page: z.never().optional() }))
    .use(applyUserPreferences)
    .query(getModelsInfiniteHandler),
  getAllPagedSimple: publicProcedure.input(getAllModelsSchema).query(getModelsPagedSimpleHandler),
  getAllWithVersions: publicProcedure
    .input(getAllModelsSchema.extend({ cursor: z.never().optional() }))
    .query(getModelsWithVersionsHandler),
  getByIdWithVersions: publicProcedure.input(getByIdSchema).query(getModelWithVersionsHandler),
  getVersions: publicProcedure.input(getByIdSchema).query(getModelVersionsHandler),
  getMyDraftModels: protectedProcedure.input(getAllQuerySchema).query(getMyDraftModelsHandler),
  add: guardedProcedure.input(modelSchema).use(checkFilesExistence).mutation(createModelHandler),
  upsert: guardedProcedure.input(modelUpsertSchema).mutation(upsertModelHandler),
  update: protectedProcedure
    .input(modelSchema.extend({ id: z.number() }))
    .use(isOwnerOrModerator)
    .use(checkFilesExistence)
    .mutation(updateModelHandler),
  delete: protectedProcedure
    .input(deleteModelSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelHandler),
  publish: protectedProcedure
    .input(publishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelHandler),
  unpublish: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelHandler),
  // TODO - TEMP HACK for reporting modal
  getModelReportDetails: publicProcedure.input(getByIdSchema).query(getModelReportDetailsHandler),
  getModelDetailsForReview: publicProcedure
    .input(getByIdSchema)
    .query(getModelDetailsForReviewHandler),
  restore: protectedProcedure.input(getByIdSchema).mutation(restoreModelHandler),
  getDownloadCommand: protectedProcedure.input(getDownloadSchema).query(getDownloadCommandHandler),
  reorderVersions: protectedProcedure
    .input(reorderModelVersionsSchema)
    .use(isOwnerOrModerator)
    .mutation(reorderModelVersionsHandler),
});
