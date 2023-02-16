import { ImageGenerationProcess, ModelFileFormat, Prisma } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { QS } from '~/utils/qs';

export const createModelFileDownloadUrl = ({
  versionId,
  type,
  format,
  primary = false,
}: {
  versionId: number;
  type?: ModelFileType | string;
  format?: ModelFileFormat;
  primary?: boolean;
}) => {
  const queryString = QS.stringify({
    type: !primary ? type : null,
    format: !primary && type !== 'Training Data' ? format : null,
  });

  return `/api/download/models/${versionId}${queryString ? '?' + queryString : ''}`;
};

export function getImageGenerationProcess(meta: Prisma.JsonObject): ImageGenerationProcess {
  const denoiseStrength = meta['Denoise strength'] ?? meta['Denoising strength'] != null;
  const hiresFixed =
    meta['First pass strength'] ?? (meta['Hires upscale'] ?? meta['Hires upscaler']) != null;
  if (meta['Mask blur'] != null) return ImageGenerationProcess.inpainting;
  if (denoiseStrength && !hiresFixed) return ImageGenerationProcess.img2img;
  if (denoiseStrength && hiresFixed) return ImageGenerationProcess.txt2imgHiRes;
  return ImageGenerationProcess.txt2img;
}
