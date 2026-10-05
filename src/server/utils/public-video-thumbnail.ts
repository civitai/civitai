import { getEdgeUrl, videoStillEdgeOptions } from '~/client-utils/edge-url';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
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
 * `getEdgeUrl` turns a width-less request into `original=true`, which serves the MP4 whatever the
 * filename says. Passing `original: false` prevents that; the cacher treats it the same as no
 * `original` at all, so it is dropped from the published URL. With no width the cacher returns the
 * source's native size.
 */
function getStillUrl(src: string, skip?: number) {
  return getEdgeUrl(src, {
    ...videoStillEdgeOptions,
    skip,
    original: false,
    optimized: true,
  }).replace('original=false,', '');
}

/** A still for a video, for public API consumers that cannot render one themselves. */
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

  // The public endpoint passes the caller's raw `browsingLevel`, which can include Blocked.
  const allowed = Flags.intersection(browsingLevel, allBrowsingLevelsFlag);
  if (customThumbnail?.nsfwLevel && Flags.intersects(customThumbnail.nsfwLevel, allowed)) {
    return {
      url: getStillUrl(customThumbnail.url),
      width: customThumbnail.width ?? null,
      height: customThumbnail.height ?? null,
    };
  }

  return {
    url: getStillUrl(image.url, getSkipValue({ type: image.type, metadata: image.metadata })),
    width: image.width ?? null,
    height: image.height ?? null,
  };
}
