import { getEdgeUrl } from '~/client-utils/edge-url';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { Flags } from '~/shared/utils/flags';
import { MediaType } from '~/shared/utils/prisma/enums';

type VideoThumbnailSource = {
  type: MediaType;
  url: string;
  width?: number | null;
  height?: number | null;
  metadata?: MixedObject | null;
};

type CustomThumbnail = {
  url: string;
  width?: number | null;
  height?: number | null;
  nsfwLevel: number;
};

export type PublicVideoThumbnail = { url: string; width: number | null; height: number | null };

/**
 * A JPEG still for a video, for public API consumers that cannot render one themselves.
 *
 * `original=false` with no width is load-bearing on both branches: `original=true` serves the
 * MP4 whatever the filename says, and `optimized=true` serves WebP. Either way the cacher returns
 * the source's native size, so the dimensions are the source's own.
 */
export function getPublicVideoThumbnail({
  image,
  customThumbnail,
  browsingLevel,
}: {
  image: VideoThumbnailSource;
  customThumbnail?: CustomThumbnail | null;
  browsingLevel: number;
}): PublicVideoThumbnail | null {
  if (image.type !== MediaType.video) return null;

  if (customThumbnail?.nsfwLevel && Flags.intersects(customThumbnail.nsfwLevel, browsingLevel)) {
    return {
      url: getEdgeUrl(customThumbnail.url, { original: false, type: MediaType.image }),
      width: customThumbnail.width ?? null,
      height: customThumbnail.height ?? null,
    };
  }

  return {
    url: getEdgeUrl(image.url, {
      anim: false,
      transcode: true,
      original: false,
      skip: getSkipValue({ type: image.type, metadata: image.metadata }),
      type: MediaType.image,
    }),
    width: image.width ?? null,
    height: image.height ?? null,
  };
}
