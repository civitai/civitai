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
  restoreModelHandler,
  unpublishModelHandler,
  updateModelHandler,
} from '~/server/controllers/model.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteModelSchema,
  getAllModelsSchema,
  getDownloadSchema,
  ModelInput,
  modelSchema,
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

export const modelRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getModelHandler),
  getAll: publicProcedure
    .input(getAllModelsSchema.extend({ page: z.never().optional() }))
    .query(getModelsInfiniteHandler),
  getAllPagedSimple: publicProcedure.input(getAllModelsSchema).query(getModelsPagedSimpleHandler),
  getAllWithVersions: publicProcedure
    .input(getAllModelsSchema.extend({ cursor: z.never().optional() }))
    .query(getModelsWithVersionsHandler),
  getVersions: publicProcedure.input(getByIdSchema).query(getModelVersionsHandler),
  add: guardedProcedure.input(modelSchema).use(checkFilesExistence).mutation(createModelHandler),
  update: protectedProcedure
    .input(modelSchema.extend({ id: z.number() }))
    .use(isOwnerOrModerator)
    .use(checkFilesExistence)
    .mutation(updateModelHandler),
  delete: protectedProcedure
    .input(deleteModelSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelHandler),
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
});
