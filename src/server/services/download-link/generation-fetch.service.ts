import { LRUCache } from 'lru-cache';
import { env } from '~/env/server';
import { componentFileTypes } from '~/server/common/constants';
import { EntityAccessPermission } from '~/server/common/enums';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { hasEntityAccess } from '~/server/services/common.service';
import { getDownloadFilename } from '~/server/services/file.service';
import { readModelVersionForFileViaKysely } from '~/server/services/hot-reads-5.reads';
import { readDownloadFilesViaKysely } from '~/server/services/hot-reads-6.reads';
import { readModeratorFlags } from '~/server/services/download-link/moderator-review.reads';
import { PROVIDER_FETCHABLE_STATUSES } from '~/server/services/download-link/provider-fetchable';
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

/**
 * A provider that runs generation jobs, authenticated by its per-provider download token. It is
 * served what generation is served today: any version that is not removed, refused or in moderator
 * review, whoever owns it and whatever its access settings, and any of its files.
 */
export type ProviderFetchPrincipal = { kind: 'provider'; provider: string };

/** The download route's file selectors, honored for a provider as `getFileForModelVersion` does. */
export type GenerationFetchSelectors = {
  type?: string;
  format?: string;
  size?: string;
  fp?: string;
  quantType?: string;
};

export const GENERATION_FETCH_REFUSALS = [
  'not-found',
  'no-access',
  'no-generation',
  'early-access',
  'archived',
  'failed-scan',
  'poi',
  'unauthorized',
  'in-review',
  'unsupported-file',
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
  /** An anonymous caller could download this file from the download route. */
  isPublic: boolean;
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
 * May `principal` have this file fetched for a generation job? Used by download-link mint and use,
 * and by the download route for a per-provider download token; other downloads keep
 * `getFileForModelVersion`.
 *
 * For a user or public principal, a generation-only (download-disabled) file is allowed and nothing
 * else is looser. A provider principal is served what generation is served (see
 * `ProviderFetchPrincipal`). For everyone, the owner included, deleted, taken-down and archived
 * models, failed scans and POI models are refused, and nobody is treated as a moderator.
 *
 * `principal: null` is a public link: it names no user, so only a published, open-access version
 * outside early access passes.
 */
export async function checkGenerationFetch({
  modelVersionId,
  fileId,
  principal,
  selectors = {},
  cacheReads = false,
}: {
  modelVersionId: number;
  fileId?: number;
  principal: GenerationFetchPrincipal | ProviderFetchPrincipal | null;
  /** Provider principal only: the download route's file selectors. */
  selectors?: GenerationFetchSelectors;
  /**
   * Share the version and file reads across a link's GETs and mini's provider mints (see
   * `gateReads`). Other mints read fresh.
   */
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

  const isProvider = !!principal && 'kind' in principal;
  const { inEarlyAccess } = await getVersionEarlyAccess(version.id);
  // Every file of the version, not only its public ones: the owner's view, and a provider's.
  let allFiles: boolean;
  if (isProvider) {
    if (
      !PROVIDER_FETCHABLE_STATUSES.includes(version.status) ||
      !PROVIDER_FETCHABLE_STATUSES.includes(version.model.status)
    )
      return refuse('not-found');
    const flags = await read('flags', () => readModeratorFlags(kyselyRead, modelVersionId));
    if (flags.removedWithOwner) return refuse('not-found');
    if (flags.inReview) return refuse('in-review');
    allFiles = true;
  } else {
    const isOwner = !!principal && version.model.userId === principal.id;
    if (!isOwner && !isVersionPublished(version)) return refuse('not-found');
    if (!principal && version.requireAuth) return refuse('unauthorized');
    // The site lets only moderators generate with these, and a link's principal never is one.
    if (version.usageControl === ModelUsageControl.InternalGeneration)
      return refuse('no-generation');

    // The check the orchestrator runs at submit (`/api/v1/permissions/check`): generation access,
    // which covers private versions and bought early access, and grants owners everything.
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
    allFiles = isOwner;
  }

  // Resolved as the download route does: an explicit file, or the version's primary file, by the
  // route's selectors when a provider sends them.
  const type = isProvider && !fileId ? selectors.type : undefined;
  const files = await read(`files:${allFiles}:${!fileId}:${type ?? ''}`, () =>
    readDownloadFilesViaKysely(kyselyRead, {
      modelVersionId,
      publicOnly: !allFiles,
      notReplaced: !fileId,
      type,
    })
  );
  let file: (typeof files)[number] | null | undefined;
  if (fileId) file = files.find((candidate) => candidate.id === fileId);
  else {
    const preferred = isProvider
      ? Object.fromEntries(
          (['format', 'size', 'fp', 'quantType'] as const)
            .filter((key) => selectors[key])
            .map((key) => [key, selectors[key]])
        )
      : {};
    file = getPrimaryFile(files as Array<(typeof files)[number] & { metadata: FileMetadata }>, {
      metadata: preferred as FileMetadata,
    });
    // The download route serves a linked component from another version here; a provider fetch
    // does not, rather than silently serving this version's primary file.
    if (!file && type && (componentFileTypes as readonly string[]).includes(type))
      return refuse('unsupported-file');
    // As the download route: a selector the picked file contradicts is not found.
    const metadata = (file?.metadata ?? {}) as Record<string, unknown>;
    if (
      file &&
      Object.entries(preferred).some(([key, value]) => metadata[key] && metadata[key] !== value)
    )
      return refuse('not-found');
  }
  // A generation job never needs a training dataset.
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
    isPublic: isProvider
      ? await isPubliclyDownloadable(version, inEarlyAccess, file.id, (key, fn) => read(key, fn))
      : false,
  };
}

/** Could an anonymous caller download this file? Labels a provider's download for its counters. */
async function isPubliclyDownloadable(
  version: NonNullable<Awaited<ReturnType<typeof readModelVersionForFileViaKysely>>>,
  inEarlyAccess: boolean,
  fileId: number,
  read: <T>(key: string, fn: () => Promise<T>) => Promise<T>
): Promise<boolean> {
  // As `getFileForModelVersion` answers an anonymous caller.
  if (
    !isVersionPublished(version) ||
    inEarlyAccess ||
    version.requireAuth ||
    !env.UNAUTHENTICATED_DOWNLOAD ||
    version.usageControl !== ModelUsageControl.Download
  )
    return false;
  const [access] = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: [version.id],
    userId: undefined,
    isModerator: false,
    permissions: EntityAccessPermission.EarlyAccessDownload,
  });
  if (!(access?.hasAccess ?? true)) return false;
  const { kyselyRead } = await loadKyselyDb();
  const publicFiles = await read('files:public', () =>
    readDownloadFilesViaKysely(kyselyRead, { modelVersionId: version.id, publicOnly: true })
  );
  return publicFiles.some((candidate) => candidate.id === fileId);
}
