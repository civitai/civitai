import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  ModelFileCreateInput,
  ModelFileUpdateInput,
  ModelFileUpsertInput,
} from '~/server/schema/model-file.schema';
import {
  createFile,
  deleteFile,
  getFilesForModelVersionCache,
  updateFile,
} from '~/server/services/model-file.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { handleLogError, throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { registerFileLocation } from '~/utils/storage-resolver';

// Wraps registerFileLocation so a resolver outage or misconfig becomes a
// logged warning instead of a silent download-breaker. A missing row in
// `file_locations` means /resolve returns 404 and the delivery-worker fallback
// only knows the primary bucket, so the file becomes un-downloadable.
async function safeRegisterFileLocation(params: {
  op: 'create' | 'update';
  userId: number;
  fileId: number;
  modelVersionId: number;
  modelId: number;
  s3Path: string;
  sizeKb: number;
}) {
  const { op, userId, fileId, modelVersionId, modelId, s3Path, sizeKb } = params;
  const backend = 'backblaze';
  try {
    await registerFileLocation({
      fileId,
      modelVersionId,
      modelId,
      backend,
      path: s3Path,
      sizeKb,
    });
  } catch (err) {
    logToAxiom({
      type: 'error',
      name: 'register-file-location-failed',
      ...safeError(err),
      op,
      fileId,
      modelVersionId,
      modelId,
      userId,
      backend,
      path: s3Path,
      sizeKb,
    }).catch(handleLogError);
  }
}

export const getFilesByVersionIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const data = await getFilesForModelVersionCache([input.id]);
    return data[input.id];
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileCreateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    // Extract B2-specific fields before passing to createFile (they aren't DB columns)
    const { backend, s3Path, ...createInput } = input;

    const file = await createFile({
      ...createInput,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      select: {
        id: true,
        name: true,
        modelVersion: {
          select: {
            id: true,
            modelId: true,
            status: true,
            _count: { select: { posts: { where: { publishedAt: { not: null } } } } },
          },
        },
      },
    });

    // Register with storage-resolver for B2 uploads so downloads work.
    // Awaited so the location is registered before scan-files can trigger.
    if (backend === 'b2' && s3Path) {
      await safeRegisterFileLocation({
        op: 'create',
        userId: ctx.user.id,
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.modelId,
        s3Path,
        sizeKb: input.sizeKB,
      });
    }

    ctx.track
      .modelFile({ type: 'Create', id: file.id, modelVersionId: file.modelVersion.id })
      .catch(handleLogError);

    return file;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileUpdateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { backend, s3Path, ...updateInput } = input;

    const result = await updateFile({
      ...updateInput,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    // Re-register with storage-resolver when the file was re-uploaded to B2
    // (e.g. training data re-uploads), so downloads resolve to the new path.
    if (backend === 'b2' && s3Path) {
      await safeRegisterFileLocation({
        op: 'update',
        userId: ctx.user.id,
        fileId: result.id,
        modelVersionId: result.modelVersionId,
        modelId: result.modelVersion.modelId,
        s3Path,
        sizeKb: updateInput.sizeKB ?? result.sizeKB ?? 0,
      });
    }

    ctx.track
      .modelFile({ type: 'Update', id: input.id, modelVersionId: result.modelVersionId })
      .catch(handleLogError);

    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertFileHandler = async ({
  input,
  ctx,
}: {
  input: ModelFileUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.id !== undefined) {
      return await updateFileHandler({ input, ctx });
    } else {
      return await createFileHandler({ input, ctx });
    }
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteFileHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const modelVersionId = await deleteFile({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    if (!modelVersionId) throw throwNotFoundError(`No file with id ${input.id}`);

    ctx.track.modelFile({ type: 'Delete', id: input.id, modelVersionId }).catch(handleLogError);

    return { modelVersionId };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
