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
}: {
  versionId: number;
  type?: ModelFileType | string;
  primary?: boolean;
  meta?: BasicFileMetadata;
}) => {
  const { format, size, fp } = meta || {};
  const queryString = QS.stringify({
    type: !primary ? type : null,
    format: !primary && type !== 'Training Data' ? format : null,
    size: !primary ? size : null,
    fp: !primary ? fp : null,
  });

  return `/api/download/models/${versionId}${queryString ? '?' + queryString : ''}`;
};

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
