import type { Prisma } from '@prisma/client';
import { COMMON_IMAGE_WIDTHS, getEdgeUrl } from '~/client-utils/edge-url';
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import { publicPostImageWhere, publishedImageWhere } from '~/server/selectors/image.selector';
import { onlySelectableLevels } from '~/shared/constants/browsingLevel.constants';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import { Flags } from '~/shared/utils/flags';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * The viewer's posted images an app may be handed by `OPEN_IMAGE_PICKER`: their own, in a published
 * post, scan complete, unflagged, and rated at a level `browsingLevel` allows.
 *
 * `browsingLevel` is the viewer's own, already capped for the domain. The rating test is the image
 * feeds': a level is allowed when it is one of the selectable levels in `browsingLevel`, so an
 * unrated image (level 0) never matches.
 *
 * `publicOnly` (the app's `OPEN_IMAGE_PICKER` `publicOnly: true`) also leaves out images whose post
 * is Private, for an app that will hand the pick to a surface that shows it to everyone, such as an
 * App Store card (`isImageInPublicPost` refuses such an image).
 */
export function postedPickableWhere(
  userId: number,
  browsingLevel: number,
  { publicOnly = false }: { publicOnly?: boolean } = {}
): Prisma.ImageWhereInput {
  return {
    userId,
    type: MediaType.image,
    ingestion: ImageIngestionStatus.Scanned,
    poi: false,
    minor: false,
    nsfwLevel: { in: Flags.instanceToArray(onlySelectableLevels(browsingLevel)) },
    width: { gt: 0 },
    height: { gt: 0 },
    ...(publicOnly ? publicPostImageWhere() : publishedImageWhere()),
  };
}

export const postedPickableSelect = {
  id: true,
  url: true,
  width: true,
  height: true,
  nsfwLevel: true,
  createdAt: true,
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
  /** For the picker's own tile label. Never sent to the app. */
  createdAt: Date;
};

/** Widest rendition a pick is served at: the width the upload bridge already hands apps. */
const POSTED_PICK_MAX_WIDTH = 1200;

// Rungs of the image CDN's width ladder, widest first. A width off the ladder is snapped up to the
// next rung, so only a rung yields a rendition whose width is the one requested.
const POSTED_PICK_WIDTHS = COMMON_IMAGE_WIDTHS.filter((w) => w <= POSTED_PICK_MAX_WIDTH).reverse();

const withinSourceImageBounds = (px: number) => px >= DIM_MIN && px <= DIM_MAX;

/**
 * The rendition a posted pick is requested at: the widest rung at which both sides fit the
 * generation source-image bounds, or `null` when none does (an extreme aspect ratio).
 *
 * The size is what the image CDN is ASKED for. It normally serves exactly that, scaling in either
 * direction and rounding the height, but it can answer with the original while a rendition is not
 * ready, so this is not a measurement of the bytes at the url.
 */
export function postedPickRendition(original: { width: number; height: number }) {
  for (const width of POSTED_PICK_WIDTHS) {
    const height = Math.round((original.height * width) / original.width);
    if (withinSourceImageBounds(width) && withinSourceImageBounds(height)) return { width, height };
  }
  return null;
}

/**
 * `null` for a row that cannot be described as a pick. The rating and flag rules are the query's
 * (`postedPickableWhere`); this only decides whether a usable rendition exists.
 */
export function projectPostedPickableImage(row: PostedPickableRow): PostedPickableImage | null {
  if (!row.width || !row.height || row.width <= 0 || row.height <= 0) return null;
  // `getEdgeUrl` returns such a url untouched, so no rendition would be requested.
  if (isEdgeUrlPassthrough(row.url)) return null;
  const rendition = postedPickRendition({ width: row.width, height: row.height });
  if (!rendition) return null;
  return {
    imageId: row.id,
    key: row.url,
    url: getEdgeUrl(row.url, { width: rendition.width }),
    width: rendition.width,
    height: rendition.height,
    nsfwLevel: row.nsfwLevel,
    createdAt: row.createdAt,
  };
}
