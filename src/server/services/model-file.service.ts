import { Prisma } from '@prisma/client';
import { contentKeptError, ownerHeld, ownerHeldSql } from '~/server/services/legal-hold.service';
import { TRPCError } from '@trpc/server';
import { CacheTTL, constants, KEY_VALUE_KEYS } from '~/server/common/constants';
import type { ModelFileType } from '~/server/common/constants';
import { purgeCache } from '~/server/cloudflare/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import type {
  ModelFileCreateInput,
  ModelFileMetadata,
  ModelFileUpdateInput,
  RecentTrainingDataInput,
} from '~/server/schema/model-file.schema';
import { modelFileSelect } from '~/server/selectors/modelFile.selector';
import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { inferComponentType } from '~/server/utils/model-helpers';
import {
  ModelFileVisibility,
  ModelHashType,
  ModelStatus,
  ModelUploadType,
  TrainingStatus,
} from '~/shared/utils/prisma/enums';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { deleteModelFileObject } from '~/utils/s3-utils';
import { deregisterFileLocationsByFile } from '~/utils/storage-resolver';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import { prepareFile } from '~/utils/file-helpers';
import {
  assertFileTypeChangeAllowed,
  assertVersionAcceptsNewUpload,
} from '~/server/utils/model-file-replace';
import { assertClientFileUrlAllowed } from '~/server/utils/model-file-url-bound';

export type ModelFileCached = AsyncReturnType<typeof fetchModelFilesForCache>[number];
export async function fetchModelFilesForCache(ids: number[]) {
  return await dbRead.modelFile
    .findMany({
      where: { modelVersionId: { in: ids }, replacedAt: null },
      select: modelFileSelect,
    })
    .then((data) =>
      data.map(({ metadata, ...file }) => {
        return {
          ...file,
          // TODO: Confirm with Briant whether this can be removed or not. -> reduceToBasicFileMetadata(metadata),
          metadata: metadata as FileMetadata,
        };
      })
    );
}

/**
 * NOT EXPORTED — on purpose. Every read must go through `getFilesForModelVersionCache` (which
 * hands back a caller-owned `files` array) and every bust through
 * `deleteFilesForModelVersionCache`. Keeping the cache object module-private makes bypassing
 * the accessor structurally impossible rather than merely discouraged by a comment.
 */
const filesForModelVersionCache = createCachedObject({
  key: REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
  idKey: 'modelVersionId',
  ttl: CacheTTL.day,
  async lookupFn(ids) {
    const files = await fetchModelFilesForCache(ids);

    const records: Record<number, { modelVersionId: number; files: typeof files }> = {};
    for (const file of files) {
      if (!records[file.modelVersionId])
        records[file.modelVersionId] = { modelVersionId: file.modelVersionId, files: [] };
      records[file.modelVersionId].files.push(file);
    }
    return records;
  },
});

export function reduceToBasicFileMetadata(
  metadataRaw: Prisma.JsonValue | BasicFileMetadata
): BasicFileMetadata {
  if (typeof metadataRaw !== 'object') return {};
  const { format, size, fp } = metadataRaw as BasicFileMetadata;
  return {
    format,
    size,
    fp,
  };
}

/**
 * Read the per-version file lists, returning records whose nested `files` array is the
 * CALLER'S OWN — safe to append to, sort, or splice.
 *
 * 🔴 THE COPY IS FORWARD-PROTECTION, NOT A FIX FOR A LIVE MUTATOR. The one mutator that
 * existed — `getModelsWithVersions` doing `files.push(...vaeFile)` — is gone; that call site
 * now builds a new array (`model.service.ts`). So no caller in the tree mutates the returned
 * `files` today, and this copy is deliberately kept as belt-and-braces for the NEXT one.
 *
 * 🔴 That does NOT make the two halves circular. The call site is pinned INDEPENDENTLY of this
 * copy by `model.service.vae-append-no-mutation.test.ts`, which stubs this accessor to hand back
 * the raw cache-owned array — the copy removed — so restoring the `push` turns it red on its own.
 * Deleting this copy is therefore a real decision, not a no-op, and one that must be argued
 * against the cache layer's own contract below (relevant if the deep-clone in issue #3872 lands:
 * a clone THERE would make this copy redundant, but only once it is actually in place).
 *
 * What it protects against is the shared cache layer, whose contract is genuinely unsafe here:
 * `createCachedArray` only ever SHALLOW-clones a record before handing it out, and says so —
 * "shallow only protects TOP-LEVEL fields — nested refs are shared … consumers MUST treat
 * returned values as read-only for nested fields"
 * (`packages/civitai-redis/src/cached-array.ts`). Its FAIL-OPEN DEGRADED fetch (taken whenever
 * a cluster read rejects) resolves ONE record per id for every caller that joins the in-flight
 * lookup, so the shallow clone leaves all of them holding the SAME `files` array. An in-process
 * L1 hit shares it the same way; this cache sets no `localTtl`, so that path is latent.
 *
 * Because `filesForModelVersionCache` is module-private, EVERY read routes through here, which
 * is what makes this the single place a future appender can be made safe. Cost is one array
 * copy per record (~a few hundred short-lived allocations per feed hydration) — negligible
 * against the msgpack unpack already done on the same path.
 *
 * Array-level is the right DEPTH: no consumer mutates an individual file object, only the list.
 * Guarded rather than unconditional so a record without a `files` array keeps its pre-existing
 * shape instead of throwing on a hot public-API path. NOTE: with the real cache that guard is
 * not reachable — `lookupFn` above always initialises `files: []`, and marker records are
 * skipped inside the cache layer — so its test is an invariant guard, not regression coverage.
 *
 * The result is built into a `typeof records`-annotated object rather than cast: the annotation
 * is the only thing that makes dropping a field from the returned shape a type error.
 */
export async function getFilesForModelVersionCache(modelVersionIds: number[]) {
  const records = await filesForModelVersionCache.fetch(modelVersionIds);
  const isolated: typeof records = {};
  for (const [id, record] of Object.entries(records)) {
    isolated[id] = {
      ...record,
      files: Array.isArray(record.files) ? [...record.files] : record.files,
    };
  }
  return isolated;
}
export async function deleteFilesForModelVersionCache(modelVersionId: number) {
  await filesForModelVersionCache.bust(modelVersionId);
}

export async function createFile<TSelect extends Prisma.ModelFileSelect>({
  select,
  userId,
  isModerator,
  ...data
}: ModelFileCreateInput & { select: TSelect; userId: number; isModerator?: boolean }) {
  const file = prepareFile(data);
  // `name` is the uploaded file name, which some model types publish as the download name.
  await throwOnBlockedUserContent([data.overrideName, data.name], {
    isModerator,
    surface: 'model-file',
  });

  const ownsVersion = await dbWrite.modelVersion.findFirst({
    where: { id: data.modelVersionId, model: !isModerator ? { userId } : undefined },
  });
  if (!ownsVersion) throw throwNotFoundError();

  const result = await dbWrite.modelFile.create({
    data: {
      ...file,
      rawScanResult: file.rawScanResult !== null ? file.rawScanResult : Prisma.JsonNull,
      modelVersionId: data.modelVersionId,
    },
    select,
  });
  await deleteFilesForModelVersionCache(data.modelVersionId);

  return result;
}

export async function updateFile({
  id,
  metadata,
  userId,
  isModerator,
  backend: _backend,
  s3Path: _s3Path,
  // Ignored, not honoured: the lookup below authorizes the file you may EDIT, not a version you may
  // move it to, so writing this would let an owner attach their file to anyone's model version. The
  // upsert callers send the file's existing version, so dropping it changes nothing for them; the
  // create branch still takes it from `modelFileCreateSchema`.
  modelVersionId: _modelVersionId,
  uploadDomain,
  urlFromClient,
  ...inputData
}: ModelFileUpdateInput & {
  userId: number;
  isModerator?: boolean;
  /** The request's domain, stamped onto a new training-data upload. Never the client's value. */
  uploadDomain?: ColorDomain | null;
  /** A new url came from a client, so it must name an object the caller may attach. */
  urlFromClient?: boolean;
}) {
  const modelFile = await dbWrite.modelFile.findUnique({
    where: { id, modelVersion: { model: !isModerator ? { userId } : undefined } },
    select: replaceableFileSelect,
  });
  if (!modelFile) throw throwNotFoundError();

  // Only a changed name: the editor re-sends the stored ones with every file save, and scanning them
  // would leave a file whose name trips a list impossible to edit in any other way.
  const changedNames = [
    inputData.overrideName !== modelFile.overrideName ? inputData.overrideName : undefined,
    inputData.name !== modelFile.name ? inputData.name : undefined,
  ].filter(Boolean);
  if (changedNames.length)
    await throwOnBlockedUserContent(changedNames, { isModerator, surface: 'model-file' });

  assertFileTypeChangeAllowed(modelFile, inputData.type);

  metadata = metadata ? { ...(modelFile.metadata as Prisma.JsonObject), ...metadata } : undefined;

  if (inputData.url && inputData.url !== modelFile.url) {
    if (urlFromClient)
      await assertClientFileUrlAllowed({
        url: inputData.url,
        userId,
        isModerator: !!isModerator,
        modelVersionId: modelFile.modelVersionId,
        op: 'replace',
      });
    return replaceFileContent({
      file: modelFile,
      input: { ...inputData, url: inputData.url, metadata },
      userId,
      isModerator,
      uploadDomain: uploadDomain ?? null,
    });
  }

  const { count } = await dbWrite.modelFile.updateMany({
    where: { id },
    data: { ...inputData, metadata },
  });
  // Replaced or deleted since the lookup above: nothing was written.
  if (count === 0) throw throwNotFoundError();
  await deleteFilesForModelVersionCache(modelFile.modelVersionId);

  // Merge committed updates back into the snapshot so the returned record
  // reflects post-update state. `updateMany` doesn't return the updated row,
  // and we don't want a second round-trip.
  return {
    ...modelFile,
    metadata,
    ...(inputData.sizeKB !== undefined ? { sizeKB: inputData.sizeKB } : {}),
    replacedFileId: undefined as number | undefined,
  };
}

const replaceableFileSelect = {
  id: true,
  name: true,
  overrideName: true,
  url: true,
  type: true,
  visibility: true,
  metadata: true,
  modelVersionId: true,
  sizeKB: true,
  modelVersion: {
    select: {
      modelId: true,
      baseModel: true,
      status: true,
      trainingStatus: true,
      uploadType: true,
      model: { select: { type: true, userId: true } },
    },
  },
} satisfies Prisma.ModelFileSelect;

type ReplaceableFile = Prisma.ModelFileGetPayload<{ select: typeof replaceableFileSelect }>;

/**
 * A new upload behind an existing file becomes a new file record: the old row (and its hashes) is
 * deleted and a new one created in its place, unscanned, so nothing recorded about the old object
 * carries over to the new one.
 */
async function replaceFileContent({
  file,
  input,
  userId,
  isModerator,
  uploadDomain,
}: {
  file: ReplaceableFile;
  input: Omit<ModelFileUpdateInput, 'id' | 'modelVersionId' | 'backend' | 's3Path'> & {
    url: string;
  };
  userId: number;
  isModerator?: boolean;
  uploadDomain: ColorDomain | null;
}) {
  // Fails fast on the snapshot; the transaction below re-checks against the locked version row.
  assertVersionAcceptsNewUpload(file.modelVersion, file.type);

  const { overrideName, ...fields } = input;
  const type = (fields.type ?? file.type) as ModelFileType;
  const metadata = { ...((fields.metadata ?? file.metadata ?? {}) as ModelFileMetadata) };
  // Provenance is server-owned: a training-data upload carries the domain of the request that
  // uploaded it, whatever the request said its type was.
  delete metadata.uploadDomain;
  if (type === 'Training Data' && uploadDomain) metadata.uploadDomain = uploadDomain;
  const prepared = prepareFile({
    name: fields.name ?? file.name,
    url: fields.url,
    sizeKB: fields.sizeKB ?? file.sizeKB,
    type,
    visibility: fields.visibility ?? file.visibility,
    metadata,
  });
  const fileName = prepared.name;

  const created = await dbWrite.$transaction(async (tx) => {
    // Lock the version so a training submit or a publish cannot interleave with the swap: both
    // write this row, so they either finish first (and the re-check refuses) or wait for us.
    const [version] = await tx.$queryRaw<
      { status: ModelStatus; trainingStatus: TrainingStatus | null }[]
    >`
      SELECT status, "trainingStatus" FROM "ModelVersion"
      WHERE id = ${file.modelVersionId}::int
      FOR UPDATE
    `;
    if (!version) throw throwNotFoundError();
    assertVersionAcceptsNewUpload(version, file.type);

    // A held owner's file is not replaced: the replace deletes the old row and its bytes.
    const removed = await tx.$executeRaw`
      DELETE FROM "ModelFile" mf
      USING "ModelVersion" mv, "Model" m
      WHERE mf.id = ${file.id}
        AND mf.url = ${file.url}
        AND mv.id = mf."modelVersionId"
        AND m.id = mv."modelId"
        ${isModerator ? Prisma.empty : Prisma.sql`AND m."userId" = ${userId}`}
        AND NOT ${ownerHeldSql(Prisma.raw('m."userId"'))}
    `.catch(() => null);
    if (
      removed === null ||
      (removed === 0 &&
        (await ownerHeld(tx, fileOwnerSql(file.id, isModerator ? undefined : userId))))
    )
      throw contentKeptError(isModerator);
    // Another writer replaced or removed the file since we read it.
    if (removed === 0)
      throw throwBadRequestError('ModelFile URL was modified concurrently; retry your update');

    const row = await tx.modelFile.create({
      data: {
        ...prepared,
        overrideName: overrideName !== undefined ? overrideName : file.overrideName,
        rawScanResult: Prisma.JsonNull,
        modelVersionId: file.modelVersionId,
      },
      select: { id: true },
    });

    // Other versions can link this file as a component (settings.fileId) and would lose it
    // without a repoint. Any file type can be linked, so this always runs; "resourceId" is
    // unindexed, so it is a scan of RecommendedResource.
    const linkedFrom = await tx.$queryRaw<{ sourceId: number | null }[]>`
      UPDATE "RecommendedResource"
      SET settings = settings || jsonb_build_object(
        'fileId', ${row.id}::int,
        'fileName', ${fileName}::text
      )
      WHERE "resourceId" = ${file.modelVersionId}::int
        AND settings->>'isLinkedComponent' = 'true'
        AND settings->>'fileId' = ${String(file.id)}
      RETURNING "sourceId"
    `;

    return { id: row.id, linkedSourceIds: linkedFrom.flatMap((r) => r.sourceId ?? []) };
  });

  // Logged, not thrown, from here on: the replacement has landed, and an error now would send the
  // caller back to retry against the old id, which no longer exists.
  await deleteFilesForModelVersionCache(file.modelVersionId).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'model-file-url-change',
      message: `Failed to bust the file list for file ${file.id}`,
      error,
    }).catch(() => undefined)
  );

  // The orchestrator resolves a version's files by AIR and caches what it resolved, and
  // resourceDataCache holds the version's coverage (and linked components) for an hour; all of it
  // still describes the old file.
  await Promise.all([
    resourceDataCache.bust([file.modelVersionId, ...created.linkedSourceIds]),
    bustOrchestratorModelCache(file.modelVersionId),
  ]).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'model-file-url-change',
      message: `Failed to bust resource caches for file ${file.id}`,
      error,
    }).catch(() => undefined)
  );

  // Best-effort, after commit. The refcount check inside deleteModelFileObject skips the delete if
  // any other ModelFile row still references the url.
  deleteModelFileObject(file.url)
    .catch((error) =>
      logToAxiom({
        type: 'error',
        name: 'model-file-delete-s3-object',
        message: `Failed to delete old S3 object for file ${file.id}`,
        error,
      })
    )
    .catch(() => undefined);
  deregisterFileLocationsByFile([file.id])
    .catch((error) =>
      logToAxiom({
        type: 'error',
        name: 'model-file-delete-deregister-file-locations',
        message: `Failed to deregister file locations for file ${file.id}`,
        error,
      })
    )
    .catch(() => undefined);

  return {
    ...file,
    id: created.id,
    name: prepared.name,
    overrideName: overrideName !== undefined ? overrideName : file.overrideName,
    url: prepared.url,
    type: prepared.type,
    visibility: prepared.visibility ?? file.visibility,
    sizeKB: prepared.sizeKB,
    metadata: prepared.metadata as Prisma.JsonObject,
    replacedFileId: file.id as number | undefined,
  };
}

/** The file `id` with its model owner as `m."userId"`, for `ownerHeld`; only `userId`'s when given. */
function fileOwnerSql(id: number, userId?: number) {
  return Prisma.sql`
    FROM "ModelFile" mf
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mf.id = ${id}
    ${userId === undefined ? Prisma.empty : Prisma.sql`AND m."userId" = ${userId}`}
  `;
}

const reviewedDatasetStatuses: TrainingStatus[] = [TrainingStatus.Paused, TrainingStatus.Denied];

export async function deleteFile({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) {
  // Check if deleting a training file for a model still in draft/training state.
  // Don't pull `url` here — it could change between this read and the DELETE
  // below if a concurrent updateFile lands. We RETURN the url from DELETE
  // instead, so the S3 cleanup always targets the URL that actually got removed.
  const file = await dbWrite.modelFile.findFirst({
    where: { id, modelVersion: { model: !isModerator ? { userId } : undefined } },
    select: {
      type: true,
      modelVersion: {
        select: {
          trainingStatus: true,
          model: {
            select: { status: true },
          },
        },
      },
    },
  });

  if (!file) throw throwNotFoundError();

  // A dataset under review, or denied, stays on record for moderators; only they may remove it.
  if (
    file.type === 'Training Data' &&
    file.modelVersion.trainingStatus &&
    reviewedDatasetStatuses.includes(file.modelVersion.trainingStatus) &&
    !isModerator
  )
    throw throwBadRequestError(
      "Training data for a training run under review or denied can't be deleted."
    );

  const modelStatus = file.modelVersion.model.status;
  const isTrainingFile = file.type === 'Training Data';
  const isUnpublished = modelStatus === ModelStatus.Draft || modelStatus === ModelStatus.Training;

  if (isTrainingFile && isUnpublished) {
    throw throwBadRequestError(
      'Cannot delete training data for a model that is still in draft or training. ' +
        'This would prevent the model from being published.'
    );
  }

  const rows = await dbWrite.$queryRaw<{ modelVersionId: number; modelId: number; url: string }[]>`
    DELETE FROM "ModelFile" mf
    USING "ModelVersion" mv, "Model" m
    WHERE mf."modelVersionId" = mv.id
    AND mv."modelId" = m.id
    AND mf.id = ${id}
    ${isModerator ? Prisma.empty : Prisma.raw(`AND m."userId" = ${userId}`)}
    AND NOT ${ownerHeldSql(Prisma.raw('m."userId"'))}
    ${
      // Repeats the check above at delete time, in case the run was moved to review in between.
      isModerator
        ? Prisma.empty
        : // COALESCE: a NULL status would make the whole condition NULL and drop every dataset row.
          Prisma.sql`AND NOT (mf.type = 'Training Data' AND COALESCE(mv."trainingStatus"::text, '') IN (${Prisma.join(
            reviewedDatasetStatuses
          )}))`
    }
    RETURNING
      mv.id as "modelVersionId",
      m.id as "modelId",
      mf.url as "url"
  `.catch(() => null);

  const row = rows?.[0];
  // A held owner's file is refused. The ownership condition keeps a stranger from telling a held
  // file from a missing one.
  if (
    !row &&
    (!rows || (await ownerHeld(dbWrite, fileOwnerSql(id, isModerator ? undefined : userId))))
  )
    throw contentKeptError(isModerator);
  if (row?.modelVersionId) await deleteFilesForModelVersionCache(row.modelVersionId);

  // Clean up S3 object after DB delete succeeds (best-effort).
  // Use `row.url` (RETURNING from DELETE) — not the pre-DELETE snapshot — so a
  // concurrent updateFile that swapped the URL doesn't cause us to delete the
  // old (still-referenced) object while the row at the new URL is the one
  // that actually got removed.
  // Terminal .catch on the chain so an Axiom-side rejection can't leak as
  // an unhandled rejection in this fire-and-forget path.
  if (row?.url) {
    deleteModelFileObject(row.url)
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'model-file-delete-s3-object',
          message: `Failed to delete S3 object for file ${id}`,
          error,
        })
      )
      .catch(() => {});
  }

  // Post-commit: drop this file's storage-resolver registry row (best-effort).
  // Deleting one file leaves its model version alive, so the version-keyed
  // deregistration can never reach this entry — without a file-keyed call the
  // registry keeps describing a file that no longer exists. Keyed on `id`, the
  // id the DELETE above actually removed (a returned `row` is the proof it did),
  // never a re-read. Same fire-and-forget shape as the object cleanup beside it,
  // with a terminal .catch so an Axiom-side rejection can't leak as an unhandled
  // rejection. The helper is best-effort and never throws, but the wrapper keeps
  // a future change from turning a registry blip into a failed delete.
  if (row) {
    deregisterFileLocationsByFile([id])
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'model-file-delete-deregister-file-locations',
          message: `Failed to deregister file locations for file ${id}`,
          error,
        })
      )
      .catch(() => undefined);
  }

  return row ? { modelVersionId: row.modelVersionId, modelId: row.modelId } : undefined;
}

export async function markFileReplaced({
  fileId,
  recommendedResourceId,
}: {
  fileId: number;
  recommendedResourceId: number;
}) {
  // Quarantine (don't delete) the redundant local file: retain bytes for the
  // grace window so a bad link can be restored. Ownership + primary/Training
  // guards are enforced by addLinkedComponent before this is called.
  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: { id: true, visibility: true, metadata: true, modelVersionId: true, replacedAt: true },
  });
  if (!file) throw throwNotFoundError();

  // Idempotent: a file already quarantined must not be re-stamped — that would
  // overwrite the stashed priorVisibility (with the now-Private value) and reset
  // the 30-day clock, breaking a later restore.
  if (file.replacedAt != null) return { modelVersionId: file.modelVersionId };

  const metadata = (file.metadata ?? {}) as Record<string, unknown>;
  const now = new Date();
  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: {
      replacedAt: now,
      visibility: ModelFileVisibility.Private,
      metadata: {
        ...metadata,
        replacedBy: {
          recommendedResourceId,
          at: now.toISOString(),
          priorVisibility: file.visibility,
        },
      },
    },
  });

  await deleteFilesForModelVersionCache(file.modelVersionId);
  return { modelVersionId: file.modelVersionId };
}

export async function restoreReplacedFile({ id }: { id: number }) {
  const file = await dbWrite.modelFile.findUnique({
    where: { id },
    select: { id: true, replacedAt: true, dataPurged: true, metadata: true, modelVersionId: true },
  });
  if (!file) throw throwNotFoundError();
  if (file.replacedAt == null) throw throwBadRequestError('File is not replaced');
  if (file.dataPurged)
    throw throwBadRequestError('File bytes were already purged and cannot be restored');

  const metadata = (file.metadata ?? {}) as Record<string, unknown>;
  const replacedBy = metadata.replacedBy as { priorVisibility?: ModelFileVisibility } | undefined;
  const priorVisibility = replacedBy?.priorVisibility ?? ModelFileVisibility.Public;
  const { replacedBy: _dropped, ...restMetadata } = metadata;

  await dbWrite.modelFile.update({
    where: { id },
    data: {
      replacedAt: null,
      visibility: priorVisibility,
      metadata: restMetadata as Prisma.InputJsonValue,
    },
  });

  await deleteFilesForModelVersionCache(file.modelVersionId);
  return { modelVersionId: file.modelVersionId };
}

export const getRecentTrainingData = async ({
  userId,
  limit,
  cursor = 0,
  ...filters
}: RecentTrainingDataInput & { userId: number }) => {
  const where: Prisma.ModelFileWhereInput[] = [
    { type: 'Training Data' },
    { dataPurged: false },
    { modelVersion: { uploadType: ModelUploadType.Trained, model: { userId, deletedAt: null } } },
  ];

  if (filters.hasLabels === true || filters.labelType !== null) {
    where.push({ metadata: { path: ['numCaptions'], gt: 0 } });
  }
  if (filters.labelType !== null) {
    where.push({ metadata: { path: ['labelType'], equals: filters.labelType } });
  }
  if (filters.statuses?.length) {
    where.push({ modelVersion: { trainingStatus: { in: filters.statuses } } });
  }
  if (filters.mediaTypes?.length) {
    where.push({
      OR: [
        ...filters.mediaTypes.map((type) => ({
          modelVersion: { trainingDetails: { path: ['mediaType'], equals: type } },
        })),
        // { modelVersion: { trainingDetails: { path: ['mediaType'], equals: undefined } } },
      ],
    });
  }
  if (filters.types?.length) {
    where.push({
      OR: filters.types.map((type) => ({
        modelVersion: { trainingDetails: { path: ['type'], equals: type } },
      })),
    });
  }
  if (filters.baseModels?.length) {
    where.push({ modelVersion: { baseModel: { in: filters.baseModels } } });
  }

  try {
    const data = await dbWrite.modelFile.findMany({
      where: { AND: where },
      select: {
        id: true,
        metadata: true,
        url: true,
        sizeKB: true,
        createdAt: true,
        modelVersion: {
          select: {
            id: true,
            name: true,
            trainingStatus: true,
            trainingDetails: true,
            model: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: 'desc' },
    });

    let nextCursor: number | undefined;
    if (data.length > limit) {
      const nextItem = data.pop();
      nextCursor = nextItem?.id;
    }

    return {
      items: data,
      nextCursor,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// Mod-managed model file precision + quant-type lists (KeyValue: modelFileOptions).
export type ModelFileOptions = { precisions: string[]; quantTypes: string[] };

// Edge-cache tag shared by the public `modelFile.getOptions` procedure (edgeCacheIt) and the
// purge below, so a mod write busts the CDN immediately instead of waiting out the TTL.
export const MODEL_FILE_OPTIONS_EDGE_TAG = 'model-file-options';

const modelFileOptionDefaults: ModelFileOptions = {
  precisions: [...constants.modelFileFp],
  quantTypes: [...constants.modelFileQuantTypes],
};

function dedupeOptions(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function normalizeModelFileOptions(value: unknown): ModelFileOptions {
  const v = (value ?? {}) as Partial<Record<keyof ModelFileOptions, unknown>>;
  const pick = (input: unknown, fallback: string[]) => {
    const list = Array.isArray(input)
      ? input.filter((x): x is string => typeof x === 'string')
      : [];
    const cleaned = dedupeOptions(list);
    return cleaned.length ? cleaned : fallback;
  };
  return {
    precisions: pick(v.precisions, modelFileOptionDefaults.precisions),
    quantTypes: pick(v.quantTypes, modelFileOptionDefaults.quantTypes),
  };
}

// DB row (mod-managed) overrides the hardcoded constants; constants are the durable fallback
// when the KeyValue row is absent. Caching lives at the edge — the public tRPC procedure is
// wrapped in edgeCacheIt — so this just reads through dbKV (the primary, so writes are
// immediately self-consistent on the next read).
export async function getModelFileOptions() {
  return normalizeModelFileOptions(await dbKV.get(KEY_VALUE_KEYS.MODEL_FILE_OPTIONS));
}

// Read-before-write (dbKV reads the primary) so a partial mutation can't clobber the preserved
// list. `merge` returns the replacement for a given list; an absent input key is a no-op.
async function mutateModelFileOptions(
  input: Partial<ModelFileOptions>,
  merge: (current: string[], next: string[]) => string[]
) {
  const current = normalizeModelFileOptions(await dbKV.get(KEY_VALUE_KEYS.MODEL_FILE_OPTIONS));
  const next: ModelFileOptions = {
    precisions: input.precisions ? merge(current.precisions, input.precisions) : current.precisions,
    quantTypes: input.quantTypes ? merge(current.quantTypes, input.quantTypes) : current.quantTypes,
  };
  await dbKV.set(KEY_VALUE_KEYS.MODEL_FILE_OPTIONS, next);
  // Best-effort: the DB write is the source of truth, so a purge failure must not fail the
  // caller — worst case the CDN serves stale until its TTL expires.
  purgeCache({ tags: [MODEL_FILE_OPTIONS_EDGE_TAG] }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'purge-model-file-options-cache',
      message: (error as Error).message,
      error,
    })
  );
  return next;
}

// PUT: replace the provided list(s) wholesale.
export function setModelFileOptions(input: Partial<ModelFileOptions>) {
  return mutateModelFileOptions(input, (_current, next) => dedupeOptions(next));
}

// POST: append the provided value(s) to the existing list(s).
export function addModelFileOptions(input: Partial<ModelFileOptions>) {
  return mutateModelFileOptions(input, (current, next) => dedupeOptions([...current, ...next]));
}

// DELETE: remove the provided value(s) from the existing list(s).
export function removeModelFileOptions(input: Partial<ModelFileOptions>) {
  return mutateModelFileOptions(input, (current, next) => {
    const removal = new Set(dedupeOptions(next));
    return current.filter((x) => !removal.has(x));
  });
}

const OFFICIAL_USER_ID = constants.system.officialUserId;

// The dedicated standalone Model.type → the component role it represents. This
// is authoritative for a standalone VAE/encoder/controlnet whose file is stored
// as type='Model' (so inferComponentType on the file would wrongly say 'Checkpoint').
function componentTypeFromModelType(modelType: string): ModelFileComponentType | null {
  switch (modelType) {
    case 'VAE':
      return 'VAE';
    case 'TextEncoder':
      return 'TextEncoder';
    case 'Controlnet':
      return 'ControlNet';
    default:
      return null;
  }
}

// A file/host type maps to a linkable accessory componentType — or null if it is
// PRIMARY WEIGHTS (Model / Pruned Model / Diffusion Model / UNet), which must never
// be deduped. inferComponentType alone is not enough: it maps 'Diffusion Model' →
// 'DiffusionModel' and 'UNet' → 'UNet', which would wrongly look like accessories.
function accessoryComponentType(fileType: string): ModelFileComponentType | null {
  if (primaryModelFileTypes.includes(fileType as ModelFileType)) return null;
  return inferComponentType(fileType);
}

export type OfficialFileMatch = {
  versionId: number;
  fileId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  fileName: string;
  sizeKB: number;
  componentType: ModelFileComponentType;
};

// True when the official account holds any file of exactly this size — a cheap
// pre-filter so the client only hashes a candidate when a size collision exists.
export async function hasOfficialFileOfSize(sizeKB: number): Promise<boolean> {
  const count = await dbRead.modelFile.count({
    where: { sizeKB, modelVersion: { model: { userId: OFFICIAL_USER_ID } } },
  });
  return count > 0;
}

export async function findOfficialFileByHash({
  sha256,
}: {
  sha256: string;
}): Promise<OfficialFileMatch | null> {
  // Matched on byte identity (SHA256) + official ownership only — no reliance on
  // the caller's declared file type, so a mislabelled file (or one dropped in the
  // main file section) is checked too and can't be used to bypass dedup. Genuine
  // primary weights are safe: an official checkpoint / primary-weights match
  // yields no componentType below, so it is never linked (only accessories are).
  // Callers that delete the host row (via replaceFileId) must still skip primary
  // types themselves — addLinkedComponent refuses to delete primary weights.
  const file = await dbRead.modelFile.findFirst({
    where: {
      hashes: { some: { type: ModelHashType.SHA256, hash: sha256.toUpperCase() } }, // stored ModelFileHash.hash is UPPERCASE hex
      modelVersion: { model: { userId: OFFICIAL_USER_ID } },
    },
    orderBy: { modelVersionId: 'asc' },
    select: {
      id: true,
      name: true,
      sizeKB: true,
      type: true,
      modelVersionId: true,
      modelVersion: {
        select: { name: true, modelId: true, model: { select: { name: true, type: true } } },
      },
    },
  });
  if (!file) return null;

  // Component role from the official file's own identity: the standalone model's
  // type (VAE/encoder/controlnet), else the file's own type (a component bundled
  // in a checkpoint). Null → not a linkable accessory (a checkpoint / primary
  // weights), so it is never linked.
  const componentType =
    componentTypeFromModelType(file.modelVersion.model.type) ?? accessoryComponentType(file.type);
  if (!componentType) return null;

  return {
    versionId: file.modelVersionId,
    fileId: file.id,
    modelId: file.modelVersion.modelId,
    modelName: file.modelVersion.model.name,
    versionName: file.modelVersion.name,
    fileName: file.name,
    sizeKB: file.sizeKB,
    componentType,
  };
}
