import type { ListingAssetLevels } from '~/shared/utils/listing-rating-display';

/**
 * A moderator re-rate applied to the review page's CACHED reads, by image id.
 *
 * 🔴 WHY PATCH THE CACHE INSTEAD OF REFETCHING. Both reads take image levels from the READ
 * REPLICA, so a refetch the moment the write returns can read the OLD level back. The level the
 * server wrote is known exactly, so it is applied to the cached answers, and the queries are only
 * marked stale for the next mount.
 */

type LevelImage = { imageId: number; nsfwLevel: number };

function patchImage<T extends LevelImage | null | undefined>(
  image: T,
  id: number,
  level: number
): T {
  return image && image.imageId === id && image.nsfwLevel !== level
    ? ({ ...image, nsfwLevel: level } as T)
    : image;
}

/** A `getAssets` answer with image `id` at `level` wherever the listing shows it. */
export function assetsWithImageLevel<T extends Partial<ListingAssetLevels>>(
  view: T | undefined,
  id: number,
  level: number
): T | undefined {
  if (!view) return view;
  return {
    ...view,
    ...(view.iconId === id ? { iconNsfwLevel: level } : {}),
    ...(view.coverId === id ? { coverNsfwLevel: level } : {}),
    ...(view.redIconId === id ? { redIconNsfwLevel: level } : {}),
    ...(view.redCoverId === id ? { redCoverNsfwLevel: level } : {}),
    ...(view.screenshots
      ? {
          screenshots: view.screenshots.map((s) =>
            s.imageId === id ? { ...s, nsfwLevel: level } : s
          ),
        }
      : {}),
  } as T;
}

type PreviewMediaShape = {
  icon?: LevelImage | null;
  cover?: LevelImage | null;
  redIcon?: LevelImage | null;
  redCover?: LevelImage | null;
  screenshots?: LevelImage[];
};

/** A `getListingPreviewForReview` answer with image `id` at `level` in its media. */
export function previewWithImageLevel<T extends { media: PreviewMediaShape }>(
  preview: T | null | undefined,
  id: number,
  level: number
): T | null | undefined {
  if (!preview) return preview;
  const media = preview.media;
  return {
    ...preview,
    media: {
      ...media,
      icon: patchImage(media.icon, id, level),
      cover: patchImage(media.cover, id, level),
      redIcon: patchImage(media.redIcon, id, level),
      redCover: patchImage(media.redCover, id, level),
      ...(media.screenshots
        ? { screenshots: media.screenshots.map((s) => patchImage(s, id, level)) }
        : {}),
    },
  } as T;
}
