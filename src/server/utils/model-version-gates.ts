import { isPaidAccessActive } from '@civitai/buzz';
import { getPaidAccess } from '~/server/services/paid-access.service';
import { isModelWithheld } from '~/shared/utils/model-withhold';
import { ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * The model-version checks shared by the download route (`getFileForModelVersion`) and the
 * download-link generation fetch (`checkGenerationFetch`). Each caller decides who may bypass a
 * check; the check itself lives here once so the two cannot disagree on what it means.
 */
type GatedVersion = {
  status: string;
  model: { status: string; mode: string | null };
};

/** Deleted by its owner or the system, DMCA removals included. */
export const isModelDeleted = (version: GatedVersion) =>
  version.model.status === ModelStatus.Deleted;

export const isModelArchived = (version: GatedVersion) =>
  version.model.mode === ModelModifier.Archived;

export const isModelTakenDown = (version: GatedVersion) => isModelWithheld(version.model);

/** Both the model and the version are published. */
export const isVersionPublished = (version: GatedVersion) =>
  version.model.status === ModelStatus.Published && version.status === ModelStatus.Published;

/** Whether the version is behind an active paid-access (early access) window, and when it ends. */
export async function getVersionEarlyAccess(modelVersionId: number) {
  const paidAccess = (await getPaidAccess('ModelVersion', [modelVersionId]))[modelVersionId];
  return {
    inEarlyAccess: !!paidAccess && isPaidAccessActive(paidAccess),
    deadline: paidAccess?.endsAt ?? undefined,
  };
}
