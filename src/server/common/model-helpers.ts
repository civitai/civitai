import { Image, ImageGenerationProcess, NsfwLevel, Prisma } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { MyDraftModelGetAll } from '~/types/router';
import { QS } from '~/utils/qs';

export const createModelFileDownloadUrl = ({
  versionId,
  type,
  meta,
  primary = false,
}: {
  versionId: number;
  type?: ModelFileType | string;
  primary?: boolean;
  meta?: FileMetadata;
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

export function getImageGenerationProcess(meta: Prisma.JsonObject): ImageGenerationProcess {
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

export function isNsfwImage(image: Pick<Image, 'nsfw'>) {
  return image.nsfw !== NsfwLevel.None;
}
