import { TRPCError } from '@trpc/server';
import type { ProtectedContext } from '~/server/createContext';
import type { Tracker } from '~/server/clickhouse/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import type {
  HasOfficialFileOfSizeInput,
  ModelFileCreateInput,
  ModelFileUpdateInput,
  ModelFileUpsertInput,
} from '~/server/schema/model-file.schema';
import {
  createFile,
  deleteFile,
  getFilesForModelVersionCache,
  hasOfficialFileOfSize,
  restoreReplacedFile,
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
import { bytesToKB } from '~/utils/number-helpers';
import { assertClientFileUrlAllowed } from '~/server/utils/model-file-url-bound';
import { diffEntityChanges, resolveActorRole } from '~/server/utils/entity-change-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';

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
 *      `parseB2Url`, unless a server-side caller passed an explicit `s3Path`
 *      (the Hugging Face import). Request handlers never pass one.
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
  if (args.s3Path) return { backend: 'cloudflare', s3Path: args.s3Path };
  const parsed = parseKey(args.url);
  if (!parsed.key) return null;
  return { backend: 'cloudflare', s3Path: parsed.key };
}

/**
 * Submit a new file's scan workflow to the orchestrator. Failures here are non-fatal:
 * scanFilesFallbackJob retries the file within 5 minutes since scanRequestedAt is still null. We DO
 * want them in Axiom though — the inline path is the happy case, and a sustained spike here is the
 * earliest signal the orchestrator is unreachable.
 */
async function submitInlineScan({
  handler,
  ...file
}: {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  modelType: ModelType;
  baseModel: string;
  url: string;
  handler: 'createFileHandler' | 'updateFileHandler';
}) {
  await createModelFileScanRequest({
    ...file,
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
        message: `inline scan submission failed in ${handler}`,
        fileId: file.fileId,
        modelVersionId: file.modelVersionId,
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
  await assertClientFileUrlAllowed({
    url: input.url,
    userId: ctx.user.id,
    isModerator: !!ctx.user.isModerator,
    modelVersionId: input.modelVersionId,
    op: 'create',
  });
  return createModelFile({
    // The storage location is registered from the record's own url, as on update, never from a
    // client-supplied path, so what downloads resolve to is what gets scanned.
    input: { ...input, s3Path: undefined },
    userId: ctx.user.id,
    isModerator: !!ctx.user.isModerator,
    track: ctx.track,
    // The server's own read of the host this request arrived on. This is the ONLY source the
    // stamp may come from — see the `uploadDomain` note on `createModelFile`.
    uploadDomain: ctx.domain,
  });
};

/**
 * The same create path with no request behind it, so a job can run it: a Hugging Face import
 * attaches its own file when the transfer lands, and has no session to borrow. The url is the
 * caller's own choice, so it is not bound the way a client's is (`assertClientFileUrlAllowed`).
 */
export const createModelFile = async ({
  input,
  userId,
  isModerator,
  track,
  uploadDomain,
}: {
  input: ModelFileCreateInput;
  userId: number;
  isModerator: boolean;
  track: Tracker;
  /**
   * The domain colour to stamp onto a 'Training Data' file, which a paid training submit reads to
   * refuse an NSFW dataset prepared on red being paid for and run on green (`createTrainingWorkflow`
   * in training.orch.ts). It is a payment/safety provenance stamp, so it must be the SERVER's view
   * of the request — `ctx.domain` — and never a value off `input.metadata`.
   *
   * `null` is for callers with no request behind them (the Hugging Face transfer job): they have no
   * server-side answer, so the file is left unstamped and falls into the legacy bucket the submit
   * check lets through to post-run moderation. It does NOT mean "keep whatever the client sent" —
   * a client-supplied stamp is dropped either way.
   */
  uploadDomain: ColorDomain | null;
}) => {
  try {
    // Extract B2-specific fields before passing to createFile (they aren't DB columns)
    const { backend, s3Path, ...createInput } = input;

    // Stamp the domain the training data is uploaded under, server-side, so a paid submit can
    // refuse an NSFW dataset prepared on red being paid for on green. Never trusted from the client:
    // whatever `uploadDomain` the client put in `metadata` is dropped first, and only the caller's
    // server-derived value is written back. Mirrors the same rule in `updateFileHandler` below.
    if (createInput.type === 'Training Data') {
      const metadata = { ...createInput.metadata };
      delete metadata.uploadDomain;
      if (uploadDomain) metadata.uploadDomain = uploadDomain;
      createInput.metadata = metadata;
    }

    const file = await createFile({
      ...createInput,
      userId: userId,
      isModerator: isModerator,
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
        userId: userId,
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.modelId,
        backend: resolved.backend,
        s3Path: resolved.s3Path,
        sizeKb: input.sizeKB,
      });
    }

    track
      .modelFile({ type: 'Create', id: file.id, modelVersionId: file.modelVersion.id })
      .catch(handleLogError);

    await submitInlineScan({
      fileId: file.id,
      modelVersionId: file.modelVersion.id,
      modelId: file.modelVersion.modelId,
      modelType: file.modelVersion.model.type,
      baseModel: file.modelVersion.baseModel,
      url: createInput.url,
      handler: 'createFileHandler',
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
    const { backend, s3Path: _s3Path, ...updateInput } = input;

    // Provenance is server-owned (see createFileHandler): any client value is dropped. A new
    // training-data upload is stamped with this request's domain by updateFile; a metadata-only
    // update keeps the stored one through updateFile's merge.
    if (updateInput.metadata && 'uploadDomain' in updateInput.metadata) {
      const nextMetadata = { ...updateInput.metadata };
      delete nextMetadata.uploadDomain;
      updateInput.metadata = nextMetadata;
    }

    const result = await updateFile({
      ...updateInput,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      uploadDomain: ctx.domain,
      urlFromClient: true,
    });

    const { replacedFileId } = result;

    // Only a new upload is registered with storage-resolver, as a new file record (`result.id`),
    // before the scan below resolves it. The location comes from the record's own url, never a
    // client-supplied path, so what downloads resolve to is what gets scanned.
    const resolved = replacedFileId
      ? resolveRegistration({ backend, s3Path: undefined, url: result.url })
      : null;
    if (resolved) {
      await safeRegisterFileLocation({
        op: 'create',
        userId: ctx.user.id,
        fileId: result.id,
        modelVersionId: result.modelVersionId,
        modelId: result.modelVersion.modelId,
        backend: resolved.backend,
        s3Path: resolved.s3Path,
        sizeKb: result.sizeKB,
      });
    }

    if (replacedFileId) {
      ctx.track
        .modelFile({ type: 'Delete', id: replacedFileId, modelVersionId: result.modelVersionId })
        .catch(handleLogError);
      ctx.track
        .modelFile({ type: 'Create', id: result.id, modelVersionId: result.modelVersionId })
        .catch(handleLogError);
      // Links the old record's history to the new one.
      const ownerId = result.modelVersion.model.userId;
      ctx.track
        .entityChanges(
          diffEntityChanges({
            entityType: 'ModelFile',
            entityId: replacedFileId,
            ownerId,
            before: { replacedBy: null },
            after: { replacedBy: result.id },
            actorRole: resolveActorRole({
              actorUserId: ctx.user.id,
              ownerId,
              isModerator: ctx.user.isModerator,
            }),
            reason: 'new-upload',
          })
        )
        .catch(handleLogError);

      // Not awaited: the epoch picker and dataset upload wait on this response, and a failed or slow
      // submit loses nothing, since scanFilesFallbackJob picks up the unscanned record within minutes.
      void submitInlineScan({
        fileId: result.id,
        modelVersionId: result.modelVersionId,
        modelId: result.modelVersion.modelId,
        modelType: result.modelVersion.model.type,
        baseModel: result.modelVersion.baseModel,
        url: result.url,
        handler: 'updateFileHandler',
      });
    } else {
      ctx.track
        .modelFile({ type: 'Update', id: input.id, modelVersionId: result.modelVersionId })
        .catch(handleLogError);
    }

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

export const restoreReplacedFileHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await restoreReplacedFile({ id: input.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// Client sends bytes (file.size); convert with the same bytesToKB createFile uses so
// the stored sizeKB and this size gate agree exactly.
export const hasOfficialFileOfSizeHandler = async ({
  input,
}: {
  input: HasOfficialFileOfSizeInput;
  ctx: ProtectedContext;
}) => {
  try {
    return await hasOfficialFileOfSize(bytesToKB(input.size));
  } catch (error) {
    throw throwDbError(error);
  }
};
