import { getPresignedUrl } from '@/common/utils/s3-utils';
import { config } from '@/config';

export function getImageUrl(imageKey: string) {
  const url = getPresignedUrl({
    bucket: 'civitai-media-uploads',
    key: imageKey,
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
    expiresIn: 24*60*60, // URL valid for 1 day
  })
  return url
}
