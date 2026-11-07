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
}: {
  modelVersionId: number;
  fileId?: number;
  principal: GenerationFetchPrincipal | null;
}): Promise<GenerationFetchResult> {
  const { kyselyRead } = await loadKyselyDb();
  const version = await readModelVersionForFileViaKysely(kyselyRead, modelVersionId);
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
  const files = await readDownloadFilesViaKysely(kyselyRead, {
    modelVersionId,
    publicOnly: !isOwner,
    notReplaced: !fileId,
  });
  const file = fileId
    ? files.find((candidate) => candidate.id === fileId)
    : getPrimaryFile(files as Array<(typeof files)[number] & { metadata: FileMetadata }>);
  if (!file) return refuse('not-found');
  if (hasFailedScan(file)) return refuse('failed-scan');

  // Named against every file on the version, as the download route names it.
  const versionFiles = await readDownloadFilesViaKysely(kyselyRead, { modelVersionId });
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
