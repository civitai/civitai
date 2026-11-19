import type { ListingAssetLevels } from '~/shared/utils/listing-rating-display';

/**
 * A moderator re-rate applied to the review page's CACHED reads, by image id.
 *
 * 🔴 WHY PATCH THE CACHE INSTEAD OF REFETCHING. Both reads (`appListings.getAssets`,
 * `appListings.getListingPreviewForReview`) take image levels from the READ REPLICA, while the
 * re-rate writes the primary. A refetch issued the moment the write returns can therefore read
 * the OLD level back, leaving the approve warning up and the picker snapped back to the old
 * rating. The level the server just wrote is known exactly (the moderator branch writes the level
 * it was given), so it is applied to the cached answers directly, and the queries are only
 * marked stale, so the next mount re-reads them once the replica has caught up.
 *
 * Pure and generic over the payload, so the node-env `unit` project pins the patch.
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
