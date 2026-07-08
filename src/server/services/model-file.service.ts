import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { CacheTTL, constants, KEY_VALUE_KEYS } from '~/server/common/constants';
import type { ModelFileType } from '~/server/common/constants';
import { purgeCache } from '~/server/cloudflare/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  ModelFileCreateInput,
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
} from '~/shared/utils/prisma/enums';
import { deleteModelFileObject } from '~/utils/s3-utils';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import { prepareFile } from '~/utils/file-helpers';

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

export const filesForModelVersionCache = createCachedObject({
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

export async function getFilesForModelVersionCache(modelVersionIds: number[]) {
  return await filesForModelVersionCache.fetch(modelVersionIds);
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
  ...inputData
}: ModelFileUpdateInput & { userId: number; isModerator?: boolean }) {
  const modelFile = await dbWrite.modelFile.findUnique({
    where: { id, modelVersion: { model: !isModerator ? { userId } : undefined } },
    select: {
      id: true,
      url: true,
      metadata: true,
      modelVersionId: true,
      sizeKB: true,
      modelVersion: { select: { modelId: true } },
    },
  });
  if (!modelFile) throw throwNotFoundError();

  // If URL is changing, capture the old one for S3 cleanup
  const oldUrl = inputData.url && inputData.url !== modelFile.url ? modelFile.url : undefined;

  metadata = metadata ? { ...(modelFile.metadata as Prisma.JsonObject), ...metadata } : undefined;
  // CAS guard on URL changes: only apply if the row's url is still what we read.
  // Prevents two concurrent URL-changing updateFile calls from both scheduling a
  // delete of the same captured `oldUrl`. Pure-metadata updates skip the guard
  // so they aren't starved by url-change races.
  const updateResult = await dbWrite.modelFile.updateMany({
    where: oldUrl ? { id, url: modelFile.url } : { id },
    data: {
      ...inputData,
      metadata,
    },
  });

  // CAS lost: another writer swapped the URL between findUnique and updateMany.
  // Surface the conflict instead of silently returning success — the caller
  // needs to know their write did NOT apply. Skip the cache bust too, since
  // we didn't change anything that would invalidate it.
  if (oldUrl && updateResult.count === 0) {
    throw throwBadRequestError(
      'ModelFile URL was modified concurrently; retry your update'
    );
  }

  await deleteFilesForModelVersionCache(modelFile.modelVersionId);

  // Clean up old S3 object after DB update succeeds (best-effort).
  // Only fires when we actually swapped the URL on this call — pure-metadata
  // updates have no oldUrl to clean up. Terminal .catch on the chain so an
  // Axiom-side rejection can't leak as an unhandled rejection in this
  // fire-and-forget path. The refcount check inside deleteModelFileObject is
  // the load-bearing safety: it skips the delete if any other ModelFile row
  // still references the URL.
  if (oldUrl) {
    deleteModelFileObject(oldUrl)
      .catch((error) =>
        logToAxiom({
          type: 'error',
          name: 'model-file-delete-s3-object',
          message: `Failed to delete old S3 object for file ${id}`,
          error,
        })
      )
      .catch(() => {});
  }

  // Merge committed updates back into the snapshot so the returned record
  // reflects post-update state (e.g. `sizeKB` on a re-upload). `updateMany`
  // doesn't return the updated row, and we don't want a second round-trip.
  return {
    ...modelFile,
    metadata,
    ...(inputData.sizeKB !== undefined ? { sizeKB: inputData.sizeKB } : {}),
  };
}

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
          model: {
            select: { status: true },
          },
        },
      },
    },
  });

  if (!file) throw throwNotFoundError();

  const modelStatus = file.modelVersion.model.status;
  const isTrainingFile = file.type === 'Training Data';
  const isUnpublished = modelStatus === ModelStatus.Draft || modelStatus === ModelStatus.Training;

  if (isTrainingFile && isUnpublished) {
    throw throwBadRequestError(
      'Cannot delete training data for a model that is still in draft or training. ' +
        'This would prevent the model from being published.'
    );
  }

  const rows = await dbWrite.$queryRaw<
    { modelVersionId: number; modelId: number; url: string }[]
  >`
    DELETE FROM "ModelFile" mf
    USING "ModelVersion" mv, "Model" m
    WHERE mf."modelVersionId" = mv.id
    AND mv."modelId" = m.id
    AND mf.id = ${id}
    ${isModerator ? Prisma.empty : Prisma.raw(`AND m."userId" = ${userId}`)}
    RETURNING
      mv.id as "modelVersionId",
      m.id as "modelId",
      mf.url as "url"
  `;

  const row = rows[0];
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
    data: { replacedAt: null, visibility: priorVisibility, metadata: restMetadata },
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
    { modelVersion: { uploadType: ModelUploadType.Trained, model: { userId } } },
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
    const list = Array.isArray(input) ? input.filter((x): x is string => typeof x === 'string') : [];
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
