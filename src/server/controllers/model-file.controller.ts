import { TRPCError } from '@trpc/server';
import type { ProtectedContext } from '~/server/createContext';
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
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { logToAxiom, safeError } from '~/server/logging/client';
import { handleLogError, throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { isB2Url, parseB2Url, parseKey } from '~/utils/s3-utils';
import { registerFileLocation } from '~/utils/storage-resolver';
import { preventModelVersionLag } from '~/server/db/db-lag-helpers';
import { findOfficialFilesBySize } from '~/server/services/official-file.service';
import { bytesToKB } from '~/utils/number-helpers';

type ResolverBackend = 'backblaze' | 'cloudflare';

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
  backend: ResolverBackend;
  s3Path: string;
  sizeKb: number;
}) {
  const { op, userId, fileId, modelVersionId, modelId, backend, s3Path, sizeKb } = params;
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
 * Resolve `{ backend, s3Path }` for a storage-resolver registration.
 *
 * The upload session (`/api/upload`) returns `backend='b2'` or
 * `backend='default'`. For B2 we hit B2 directly; for `default` we hit
 * the configured `S3_UPLOAD_ENDPOINT`, which on production is Cloudflare
 * R2. Historically this handler only registered B2 uploads, leaving R2
 * uploads invisible to storage-resolver and breaking the
 * migrate-to-b2 / promote-to-r2 cycle for new files.
 *
 * Resolution order:
 *   1. If the URL is recognizable as B2 → backend='backblaze', key from
 *      `parseB2Url`. Prefer the explicit `s3Path` from the upload payload
 *      (stale client bundles may omit it, so the URL parse is a fallback).
 *   2. Otherwise, if the URL parses cleanly via `parseKey` and the key is
 *      non-empty → backend='cloudflare' (S3_UPLOAD_ENDPOINT, i.e. R2).
 *   3. Otherwise → null (skip registration; logged upstream).
 *
 * NOTE: we trust `parseKey` for R2 URLs because the upload session
 * guarantees the URL is one of our configured endpoints (B2 or
 * S3_UPLOAD_ENDPOINT). Random external URLs won't appear here.
 */
function resolveRegistration(args: {
  backend: string | undefined;
  s3Path: string | undefined;
  url: string | undefined | null;
}): { backend: ResolverBackend; s3Path: string } | null {
  // B2 path — preserve prior behavior (explicit s3Path > URL parse).
  if (args.backend === 'b2' || (args.url && isB2Url(args.url))) {
    if (args.s3Path) return { backend: 'backblaze', s3Path: args.s3Path };
    if (!args.url) return null;
    const b2 = parseB2Url(args.url);
    return b2 ? { backend: 'backblaze', s3Path: b2.key } : null;
  }

  // R2 / S3_UPLOAD_ENDPOINT path — uses parseKey, which handles both
  // path-style and virtual-host-style URLs against the configured host.
  if (!args.url) return null;
  // Trust client-provided s3Path when present even for R2 (forward-compat
  // with future client changes that send it for non-B2 uploads).
  if (args.s3Path) return { backend: 'cloudflare', s3Path: args.s3Path };
  const parsed = parseKey(args.url);
  if (!parsed.key) return null;
  return { backend: 'cloudflare', s3Path: parsed.key };
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
  ctx: ProtectedContext;
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

    // Register with storage-resolver for both R2 and B2 uploads so downloads
    // resolve correctly through the promote/migrate/verify cycle. Awaited so
    // the location is registered before scan-files can trigger.
    const resolved = resolveRegistration({ backend, s3Path, url: createInput.url });
    if (resolved) {
      await safeRegisterFileLocation({
        op: 'create',
        userId: ctx.user.id,
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.modelId,
        backend: resolved.backend,
        s3Path: resolved.s3Path,
        sizeKb: input.sizeKB,
      });
    }

    ctx.track
      .modelFile({ type: 'Create', id: file.id, modelVersionId: file.modelVersion.id })
      .catch(handleLogError);

    // Submit model file scan workflow to orchestrator. Failures here are
    // non-fatal: scanFilesFallbackJob will retry the file within 5 minutes
    // since scanRequestedAt is still null. We DO want them in Axiom though —
    // the inline path is the happy case, and a sustained spike here is the
    // earliest signal the orchestrator is unreachable.
    await createModelFileScanRequest({
      fileId: file.id,
      modelVersionId: file.modelVersion.id,
      modelId: file.modelVersion.modelId,
      modelType: file.modelVersion.model.type,
      baseModel: file.modelVersion.baseModel,
      url: createInput.url,
      // Skip pre-flight on inline submission: the file just landed and
      // storage-resolver may not have finished propagating, so the
      // pre-flight's 60s retry would block the upload response. If the
      // file truly is missing, scanFilesFallbackJob will catch it 5 min
      // later via its own pre-flight and tombstone properly.
      preflight: false,
    }).catch((err) => {
      // Inline path is log-only on failure regardless of code: never
      // tombstone here. A 'not-found' would only happen if pre-flight had
      // run, which it didn't. 'transient' is the expected case (orchestrator
      // outage); fallback job will retry. Inline-path errors stay visible
      // in Axiom so a sustained spike still surfaces as the earliest
      // signal the orchestrator is unreachable.
      const submissionErrorCode =
        err instanceof ModelFileScanSubmissionError ? err.code : 'transient';
      logToAxiom(
        {
          type: 'error',
          name: 'model-file-scan',
          message: 'inline scan submission failed in createFileHandler',
          fileId: file.id,
          modelVersionId: file.modelVersion.id,
          submissionErrorCode,
          responseStatus: err instanceof ModelFileScanSubmissionError ? err.status : undefined,
          orchestratorMessages:
            err instanceof ModelFileScanSubmissionError ? err.orchestratorMessages : undefined,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'webhooks'
      ).catch();
    });

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
  ctx: ProtectedContext;
}) => {
  try {
    const { backend, s3Path, ...updateInput } = input;

    const result = await updateFile({
      ...updateInput,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    // Re-register with storage-resolver when the file was re-uploaded
    // (e.g. training data re-uploads to B2, or new model uploads to R2),
    // so downloads resolve to the new path.
    const resolved = resolveRegistration({ backend, s3Path, url: updateInput.url });
    if (resolved) {
      await safeRegisterFileLocation({
        op: 'update',
        userId: ctx.user.id,
        fileId: result.id,
        modelVersionId: result.modelVersionId,
        modelId: result.modelVersion.modelId,
        backend: resolved.backend,
        s3Path: resolved.s3Path,
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
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

// Client sends bytes (file.size); convert with the same bytesToKB createFile uses so
// the stored sizeKB and this size gate agree exactly.
export function findOfficialFilesBySizeHandler(input: { size: number }) {
  return findOfficialFilesBySize(bytesToKB(input.size));
}
