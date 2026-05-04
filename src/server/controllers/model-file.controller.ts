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
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { handleLogError, throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { parseB2Url } from '~/utils/s3-utils';
import { registerFileLocation } from '~/utils/storage-resolver';
import { preventModelVersionLag } from '~/server/db/db-lag-helpers';

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
    // `...safeError(err)` spreads a `name: 'Error'` (JS Error.name), so it
    // must come BEFORE our `name` literal or the event is hidden under a
    // generic name in Axiom.
    logToAxiom({
      type: 'error',
      ...safeError(err),
      name: 'register-file-location-failed',
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

/**
 * Derive the s3 path for a B2 registration. Prefers the explicit `s3Path`
 * from the client payload, falls back to parsing the committed URL. The
 * fallback covers users running stale client bundles that don't yet send
 * `s3Path` on the tRPC upsert — training pages live for hours during a run,
 * so a frontend deploy can take a long time to reach every open tab.
 */
function resolveB2Path(args: {
  backend: string | undefined;
  s3Path: string | undefined;
  url: string | undefined | null;
}): string | null {
  if (args.backend !== 'b2') return null;
  if (args.s3Path) return args.s3Path;
  if (!args.url) return null;
  return parseB2Url(args.url)?.key ?? null;
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
            baseModel: true,
            status: true,
            model: { select: { type: true } },
            _count: { select: { posts: { where: { publishedAt: { not: null } } } } },
          },
        },
      },
    });

    // Register with storage-resolver for B2 uploads so downloads work.
    // Awaited so the location is registered before scan-files can trigger.
    const resolvedPath = resolveB2Path({ backend, s3Path, url: createInput.url });
    if (resolvedPath) {
      await safeRegisterFileLocation({
        op: 'create',
        userId: ctx.user.id,
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.modelId,
        s3Path: resolvedPath,
        sizeKb: input.sizeKB,
      });
    }

    ctx.track
      .modelFile({ type: 'Create', id: file.id, modelVersionId: file.modelVersion.id })
      .catch(handleLogError);

    // Submit model file scan workflow to orchestrator. Gated behind the
    // MODEL_FILE_SCAN_ORCHESTRATOR flag — when OFF, the legacy scanFilesJob
    // cron picks up the file via its Pending poll instead.
    //
    // Failures here are non-fatal: scanFilesFallbackJob will retry the file
    // within 5 minutes since scanRequestedAt is still null. We DO want them in
    // Axiom though — the inline path is the happy case, and a sustained spike
    // here is the earliest signal the orchestrator is unreachable.
    if (await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR)) {
      await createModelFileScanRequest({
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.modelId,
        modelType: file.modelVersion.model.type,
        baseModel: file.modelVersion.baseModel,
      }).catch((err) => {
        logToAxiom(
          {
            type: 'error',
            name: 'model-file-scan',
            message: 'inline scan submission failed in createFileHandler',
            fileId: file.id,
            modelVersionId: file.modelVersion.id,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'webhooks'
        ).catch();
      });
    }

    // Mark this version as recently mutated so subsequent reads route to the
    // primary DB instead of the lagging replica.
    await preventModelVersionLag(file.modelVersion.modelId, file.modelVersion.id);

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
    const resolvedPath = resolveB2Path({ backend, s3Path, url: updateInput.url });
    if (resolvedPath) {
      await safeRegisterFileLocation({
        op: 'update',
        userId: ctx.user.id,
        fileId: result.id,
        modelVersionId: result.modelVersionId,
        modelId: result.modelVersion.modelId,
        s3Path: resolvedPath,
        sizeKb: updateInput.sizeKB ?? result.sizeKB ?? 0,
      });
    }

    ctx.track
      .modelFile({ type: 'Update', id: input.id, modelVersionId: result.modelVersionId })
      .catch(handleLogError);

    await preventModelVersionLag(result.modelVersion.modelId, result.modelVersionId);

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
    const result = await deleteFile({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
    if (!result) throw throwNotFoundError(`No file with id ${input.id}`);
    const { modelVersionId, modelId } = result;

    ctx.track.modelFile({ type: 'Delete', id: input.id, modelVersionId }).catch(handleLogError);

    await preventModelVersionLag(modelId, modelVersionId);

    return { modelVersionId };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
