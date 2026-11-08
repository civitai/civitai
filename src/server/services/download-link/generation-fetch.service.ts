import { LRUCache } from 'lru-cache';
import { EntityAccessPermission } from '~/server/common/enums';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { hasEntityAccess } from '~/server/services/common.service';
import { getDownloadFilename } from '~/server/services/file.service';
import { readModelVersionForFileViaKysely } from '~/server/services/hot-reads-5.reads';
import { readDownloadFilesViaKysely } from '~/server/services/hot-reads-6.reads';
import { hasFailedScan } from '~/server/utils/failed-scan';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import {
  getVersionEarlyAccess,
  isModelArchived,
  isModelDeleted,
  isModelTakenDown,
  isVersionPublished,
} from '~/server/utils/model-version-gates';
import { Availability, ModelStatus, ModelUsageControl } from '~/shared/utils/prisma/enums';

/**
 * Whose access a download link carries. Always built field by field, never spread from a loaded
 * session user, so a moderator named on a link is checked as an ordinary user.
 */
export type GenerationFetchPrincipal = { id: number; isModerator: false };

export const GENERATION_FETCH_REFUSALS = [
  'not-found',
  'no-access',
  'no-generation',
  'early-access',
  'archived',
  'failed-scan',
  'poi',
  'unauthorized',
] as const;
export type GenerationFetchRefusal = (typeof GENERATION_FETCH_REFUSALS)[number];

export type GenerationFetchFile = {
  modelId: number;
  modelVersionId: number;
  fileId: number;
  fileUrl: string;
  fileName: string;
  sizeKB: number;
  nsfw: boolean;
  inEarlyAccess: boolean;
};

export type GenerationFetchResult =
  | ({ ok: true } & GenerationFetchFile)
  | { ok: false; error: GenerationFetchRefusal };

/**
 * A version's link GETs share the version and file reads for 30s: a worker fetching a large file as
 * ranges GETs a link hundreds of times. Every decision made from those rows (takedown, unpublish,
 * ownership, scan state, file visibility) can take up to 30s to reach a live link; the storage URL
 * a GET already handed out outlives that. Credential, user and grant checks are never cached.
 */
const GATE_READ_TTL_MS = 30_000;
const gateReads = new LRUCache<string, Promise<unknown>>({
  max: 10_000,
  ttl: GATE_READ_TTL_MS,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});

function cachedGateRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = gateReads.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = read();
  gateReads.set(key, pending);
  pending.catch(() => {
    if (gateReads.get(key) === pending) gateReads.delete(key);
  });
  return pending;
}

/** For tests: drops every cached gate read. */
export const clearGateReadCache = () => gateReads.clear();

const refuse = (error: GenerationFetchRefusal): GenerationFetchResult => ({ ok: false, error });

/**
 * May `principal` have this file fetched for a generation job? Used by download-link mint and use
 * only; the download route keeps `getFileForModelVersion`.
 *
 * Unlike a download, a generation-only (download-disabled) file is allowed. Nothing else is
 * looser: deleted, taken-down and archived models, failed scans and POI models are refused for
 * everyone, the owner included, and nobody is treated as a moderator.
 *
 * `principal: null` is a public link: it names no user, so only a published, open-access version
 * outside early access passes.
 */
export async function checkGenerationFetch({
  modelVersionId,
  fileId,
  principal,
  cacheReads = false,
}: {
  modelVersionId: number;
  fileId?: number;
  principal: GenerationFetchPrincipal | null;
  /** Share the version and file reads across a link's GETs (see `gateReads`). Mint reads fresh. */
  cacheReads?: boolean;
}): Promise<GenerationFetchResult> {
  const { kyselyRead } = await loadKyselyDb();
  const read = <T>(key: string, fn: () => Promise<T>) =>
    cacheReads ? cachedGateRead(`${modelVersionId}:${key}`, fn) : fn();
  const version = await read('version', () =>
    readModelVersionForFileViaKysely(kyselyRead, modelVersionId)
  );
  if (!version) return refuse('not-found');
  if (
    isModelDeleted(version) ||
    version.status === ModelStatus.Deleted ||
    isModelTakenDown(version)
  )
    return refuse('not-found');
  if (isModelArchived(version)) return refuse('archived');
  if (version.model.poi) return refuse('poi');

  const isOwner = !!principal && version.model.userId === principal.id;
  if (!isOwner && !isVersionPublished(version)) return refuse('not-found');
  if (!principal && version.requireAuth) return refuse('unauthorized');
  // The site lets only moderators generate with these, and a link's principal never is one.
  if (version.usageControl === ModelUsageControl.InternalGeneration) return refuse('no-generation');

  // The check the orchestrator runs at submit (`/api/v1/permissions/check`): generation access,
  // which covers private versions and bought early access, and grants owners everything.
  const { inEarlyAccess } = await getVersionEarlyAccess(version.id);
  if (!principal && inEarlyAccess) return refuse('early-access');
  const [access] = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: [version.id],
    userId: principal?.id,
    isModerator: false,
    permissions: EntityAccessPermission.EarlyAccessGeneration,
  });
  if (!access?.hasAccess) {
    if (inEarlyAccess) return refuse('early-access');
    if (access?.availability === Availability.Private) return refuse('no-access');
    return refuse('no-generation');
  }

  // Resolved as the download route does: an explicit file, or the version's primary file.
  const files = await read(`files:${isOwner}:${!fileId}`, () =>
    readDownloadFilesViaKysely(kyselyRead, {
      modelVersionId,
      publicOnly: !isOwner,
      notReplaced: !fileId,
    })
  );
  const file = fileId
    ? files.find((candidate) => candidate.id === fileId)
    : getPrimaryFile(files as Array<(typeof files)[number] & { metadata: FileMetadata }>);
  // A generation job never needs a training dataset, and this path has none of the dataset gates.
  if (!file || file.type === 'Training Data') return refuse('not-found');
  if (hasFailedScan(file)) return refuse('failed-scan');

  // Named against every file on the version, as the download route names it.
  const versionFiles = await read('files', () =>
    readDownloadFilesViaKysely(kyselyRead, { modelVersionId })
  );
  return {
    ok: true,
    modelId: version.model.id,
    modelVersionId: version.id,
    fileId: file.id,
    fileUrl: file.url,
    fileName: getDownloadFilename({
      model: version.model,
      modelVersion: version,
      file,
      versionFiles,
    }),
    sizeKB: file.sizeKB,
    nsfw: version.model.nsfw,
    inEarlyAccess,
  };
}
