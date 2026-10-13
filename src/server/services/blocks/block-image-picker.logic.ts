import type { Prisma } from '@prisma/client';
import { COMMON_IMAGE_WIDTHS, getEdgeUrl } from '~/client-utils/edge-url';
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import { publishedImageWhere } from '~/server/selectors/image.selector';
import {
  classifyBlockImageUploadScan,
  isWithinSfwImageCeiling,
} from '~/server/services/blocks/block-image-upload.logic';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * Every `Image.nsfwLevel` value `isWithinSfwImageCeiling` accepts, enumerated so the ceiling can be
 * a SQL `IN` filter. A level carrying a bit outside the known set is not listed, so it is excluded.
 */
export const POSTED_PICKABLE_NSFW_LEVELS: number[] = Array.from(
  { length: allBrowsingLevelsFlag + 1 },
  (_, level) => level
).filter(isWithinSfwImageCeiling);

/**
 * The viewer's posted images an app may be handed by `OPEN_IMAGE_PICKER`: every row this matches
 * is one `classifyBlockImageUploadScan` calls `ready`, in a published post, with stored dimensions.
 */
export function postedPickableWhere(userId: number): Prisma.ImageWhereInput {
  return {
    userId,
    type: MediaType.image,
    ingestion: ImageIngestionStatus.Scanned,
    poi: false,
    minor: false,
    nsfwLevel: { in: POSTED_PICKABLE_NSFW_LEVELS },
    width: { gt: 0 },
    height: { gt: 0 },
    ...publishedImageWhere(),
  };
}

export const postedPickableSelect = {
  id: true,
  url: true,
  width: true,
  height: true,
  nsfwLevel: true,
  ingestion: true,
  needsReview: true,
  poi: true,
  minor: true,
  tosViolation: true,
} satisfies Prisma.ImageSelect;

export type PostedPickableRow = Prisma.ImageGetPayload<{ select: typeof postedPickableSelect }>;

export type PostedPickableImage = {
  imageId: number;
  /** Storage key, for the picker's own thumbnail. Never sent to the app. */
  key: string;
  url: string;
  width: number;
  height: number;
  nsfwLevel: number;
};

/** Widest rendition a pick is served at: the width the upload bridge already hands apps. */
const POSTED_PICK_MAX_WIDTH = 1200;

// Rungs of the image CDN's width ladder, widest first. A width off the ladder is snapped up to the
// next rung, so only a rung yields a rendition whose width is the one requested.
const POSTED_PICK_WIDTHS = COMMON_IMAGE_WIDTHS.filter((w) => w <= POSTED_PICK_MAX_WIDTH).reverse();

const withinSourceImageBounds = (px: number) => px >= DIM_MIN && px <= DIM_MAX;

/**
 * Width to request for a posted pick, and the size the image CDN returns for it. The CDN scales to
 * the requested width in both directions (it upscales a narrower original) and rounds the height.
 *
 * Steps down the ladder until both sides fit the generation source-image bounds, so a tall image
 * is still usable as a `sourceImage`. An image no rung fits is served at the widest one.
 */
export function postedPickRendition(original: { width: number; height: number }) {
  const at = (width: number) => ({
    width,
    height: Math.round((original.height * width) / original.width),
  });
  const candidates = POSTED_PICK_WIDTHS.map(at);
  return (
    candidates.find((c) => withinSourceImageBounds(c.width) && withinSourceImageBounds(c.height)) ??
    candidates[0]
  );
}

/** `null` for a row that must not be offered; the query already excludes all of them but a legacy url. */
export function projectPostedPickableImage(row: PostedPickableRow): PostedPickableImage | null {
  if (classifyBlockImageUploadScan(row).status !== 'ready') return null;
  if (!row.width || !row.height || row.width <= 0 || row.height <= 0) return null;
  // `getEdgeUrl` returns such a url untouched, so it would not be the rendition measured below.
  if (isEdgeUrlPassthrough(row.url)) return null;
  const rendition = postedPickRendition({ width: row.width, height: row.height });
  return {
    imageId: row.id,
    key: row.url,
    url: getEdgeUrl(row.url, { width: rendition.width }),
    width: rendition.width,
    height: rendition.height,
    nsfwLevel: row.nsfwLevel,
  };
}
