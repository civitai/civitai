import { ImageGenerationProcess, ModelStatus, TrainingStatus } from '~/shared/utils/prisma/enums';
import type { ModelFileType } from '~/server/common/constants';
import { constants } from '~/server/common/constants';
import type { MyDraftModelGetAll, MyTrainingModelGetAll } from '~/types/router';
import { QS } from '~/utils/qs';
import dayjs from '~/shared/utils/dayjs';

export const createModelFileDownloadUrl = ({
  versionId,
  type,
  meta,
  primary = false,
  fileId,
}: {
  versionId: number;
  type?: ModelFileType | string;
  primary?: boolean;
  meta?: BasicFileMetadata;
  fileId?: number;
}) => {
  const { format, size, fp, quantType } = meta || {};
  const queryString = QS.stringify({
    fileId: fileId ?? null,
    type: !primary && !fileId ? type : null,
    format: !primary && !fileId && type !== 'Training Data' ? format : null,
    size: !primary && !fileId ? size : null,
    fp: !primary && !fileId ? fp : null,
    quantType: !primary && !fileId ? quantType : null,
  });

  return `/api/download/models/${versionId}${queryString ? '?' + queryString : ''}`;
};

/**
 * The ONE place a per-file `downloadUrl` is built for a serialized file list.
 *
 * INVARIANT: a `fileId` is only ever emitted next to the version that file
 * actually belongs to. That is not automatic, because both public shapers
 * splice CROSS-VERSION files into a version's file list: `getVaeFiles`
 * (model.service) reads the primary `Model` files off a LINKED component
 * version, relabels them `VAE`, and pushes them into the HOST version's array
 * carrying their own ids. Pinning such a file's id to the host version emits a
 * pair the download route resolves as `findFirst({ id: fileId, modelVersionId })`
 * (file.service) → null → a hard 404 on a URL that used to work.
 *
 * So the pin is gated on an identity comparison — `hostVersionId` is the only
 * version id this function will ever put in the path, and `fileId` rides along
 * ONLY when the file says it belongs to that same version.
 *
 * A file the host version does NOT own keeps the pre-pin, discriminator-based
 * URL: the download route re-resolves it and, for a component type
 * (`isComponentFileType` — VAE/Text Encoder/UNet/…), satisfies it through the
 * linked-component fallback. That is byte-identical to the URL those files
 * carried before pinning existed, which is deliberate — it keeps their access
 * gating (evaluated against the HOST version) and their download attribution
 * exactly where they were. Re-pointing the URL at the file's own version would
 * silently move both, so it is not done here.
 *
 * A file with a missing/null `modelVersionId` takes the same unpinned branch:
 * we cannot prove the pair is consistent, and an unpinned URL cannot 404. Both
 * production sources select `modelVersionId` explicitly (`modelFileSelect`, and
 * `getVaeFiles`' own select), so this is a deliberate fail-safe, not a path
 * production is expected to take.
 */
export const createSerializedFileDownloadUrl = ({
  file,
  hostVersionId,
  primary = false,
}: {
  file: {
    id: number;
    modelVersionId?: number | null;
    type?: ModelFileType | string;
    metadata?: BasicFileMetadata | null;
  };
  hostVersionId: number;
  primary?: boolean;
}) => {
  const owned = file.modelVersionId != null && file.modelVersionId === hostVersionId;
  if (owned) return createModelFileDownloadUrl({ versionId: hostVersionId, fileId: file.id });

  return createModelFileDownloadUrl({
    versionId: hostVersionId,
    type: file.type,
    meta: file.metadata ?? undefined,
    primary,
  });
};

/**
 * Reduce a DB model file to the shape `getModelsWithVersions` hands its two
 * public consumers: the raw `metadata` JSON narrowed to the five published
 * fields, everything else passed through UNTOUCHED.
 *
 * "Everything else" is load-bearing and is why this is a named function rather
 * than an inline map: it must keep `modelVersionId`. A version's file list can
 * contain files spliced in from a LINKED version (`files.push(...vaeFile)`), so
 * that field is the ONLY thing telling a consumer which version owns a given
 * file — and `createSerializedFileDownloadUrl` needs it to decide whether the
 * file's id may be pinned into a download URL. Dropping it here silently pairs
 * a foreign file id with the host version, i.e. a 404.
 */
export function toApiModelFile<T extends { metadata?: unknown }>({
  metadata: metadataRaw,
  ...file
}: T) {
  const metadata = metadataRaw as FileMetadata | undefined;
  return {
    ...file,
    metadata: {
      format: metadata?.format,
      size: metadata?.size,
      fp: metadata?.fp,
      quantType: metadata?.quantType,
      isRequired: metadata?.isRequired,
    },
  };
}

export function getImageGenerationProcess(meta: MixedObject): ImageGenerationProcess {
  // if (meta['comfy'] != null) return ImageGenerationProcess.comfy; // Enable this after the search migration is complete

  const denoiseStrength = meta['Denoise strength'] ?? meta['Denoising strength'] != null;
  const hiresFixed =
    meta['First pass strength'] ?? (meta['Hires upscale'] ?? meta['Hires upscaler']) != null;
  if (meta['Mask blur'] != null) return ImageGenerationProcess.inpainting;
  if (denoiseStrength && !hiresFixed) return ImageGenerationProcess.img2img;
  if (denoiseStrength && hiresFixed) return ImageGenerationProcess.txt2imgHiRes;
  return ImageGenerationProcess.txt2img;
}

export function getModelWizardUrl(model: MyDraftModelGetAll['items'][number]) {
  const hasVersion = model._count.modelVersions > 0;
  const hasFiles = model.modelVersions.some((version) => version._count.files > 0);
  const hasPosts = model.modelVersions.some((version) => version._count.posts > 0);

  if (!hasVersion) return `/models/${model.id}/wizard?step=2`;
  if (hasVersion && !hasFiles && !hasPosts) return `/models/${model.id}/wizard?step=3`;
  if (hasVersion && hasFiles && !hasPosts) return `/models/${model.id}/wizard?step=4`;

  return `/models/${model.id}`;
}

export function getModelTrainingWizardUrl(mv: MyTrainingModelGetAll['items'][number]) {
  const trainingStatus = mv.trainingStatus;

  if (mv.model.status === ModelStatus.Published) {
    return `/models/${mv.model.id}/model-versions/${mv.id}/wizard?step=1`;
  }

  if (trainingStatus && trainingStatus !== TrainingStatus.Pending) {
    // TODO [bw] what should we do here? check for specific other values?
    return `/models/${mv.model.id}/wizard?step=1&modelVersionId=${mv.id}`;
  }

  const hasTrainingData = !!mv.files.length;

  if (!hasTrainingData) return `/models/train?modelId=${mv.model.id}&step=2`;
  return `/models/train?modelId=${mv.model.id}&step=3`;
}

export const canGenerateWithEpoch = (trainingCompletedAt?: string | Date | null) => {
  if (!trainingCompletedAt) {
    return false;
  }

  // Check that the epoch is not older than 15 days.
  const isValid = dayjs(trainingCompletedAt)
    .add(constants.imageGeneration.epochGenerationTimeLimit, 'days')
    .isAfter(dayjs());
  return isValid;
};
