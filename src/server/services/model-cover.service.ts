import { dbRead } from '~/server/db/client';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isDefined } from '~/utils/type-guards';

/**
 * A picked cover must be the creator's own published image on this model, and the .com one must
 * be rated PG or PG13. Throws on the first id that is not.
 */
export async function assertCoverImagesValid({
  modelId,
  ownerId,
  coverImageId,
  sfwCoverImageId,
}: {
  modelId: number;
  ownerId: number;
  coverImageId?: number | null;
  sfwCoverImageId?: number | null;
}) {
  const ids = [coverImageId, sfwCoverImageId].filter(isDefined);
  if (!ids.length) return;

  const images = await dbRead.image.findMany({
    where: {
      id: { in: ids },
      post: { userId: ownerId, publishedAt: { not: null }, modelVersion: { modelId } },
    },
    select: { id: true, nsfwLevel: true },
  });
  const byId = new Map(images.map((image) => [image.id, image]));

  if (coverImageId && !byId.has(coverImageId))
    throw throwBadRequestError('The cover must be one of your published images on this model.');
  if (sfwCoverImageId) {
    const image = byId.get(sfwCoverImageId);
    if (!image)
      throw throwBadRequestError(
        'The civitai.com cover must be one of your published images on this model.'
      );
    if (!image.nsfwLevel || (image.nsfwLevel & sfwBrowsingLevelsFlag) !== image.nsfwLevel)
      throw throwBadRequestError('The civitai.com cover must be an image rated PG or PG-13.');
  }
}

/**
 * The chosen cover for each model, by model id. A cover counts only when it is the model owner's
 * image on one of the model's own versions; a cover already among the shown version's images comes
 * from there, and one on another version through the same cached, creator-only version-image read,
 * so it carries the same shape and filters. A dangling or foreign id is simply absent.
 */
export async function getCoverImages({
  covers,
  modelVersionImages,
  sameVersionOnly,
}: {
  covers: { modelId: number; ownerId: number; shownVersionId?: number; coverId: number | null }[];
  modelVersionImages: Record<number, { images: ImagesForModelVersions[] }>;
  sameVersionOnly: boolean;
}) {
  const found = new Map<number, ImagesForModelVersions>();
  const wanted = covers.filter(
    (cover): cover is typeof cover & { coverId: number } => cover.coverId != null
  );
  if (!wanted.length) return found;

  const pending: typeof wanted = [];
  for (const cover of wanted) {
    const shown = cover.shownVersionId ? modelVersionImages[cover.shownVersionId]?.images : [];
    const image = shown?.find((candidate) => candidate.id === cover.coverId);
    if (image) found.set(cover.modelId, image);
    else pending.push(cover);
  }
  if (!pending.length || sameVersionOnly) return found;

  const rows = await dbRead.image.findMany({
    where: { id: { in: pending.map((cover) => cover.coverId) } },
    select: {
      id: true,
      post: {
        select: { userId: true, modelVersionId: true, modelVersion: { select: { modelId: true } } },
      },
    },
  });
  const located = pending.flatMap((cover) => {
    const row = rows.find((candidate) => candidate.id === cover.coverId);
    const versionId = row?.post?.modelVersionId;
    const owned =
      row?.post?.modelVersion?.modelId === cover.modelId && row.post.userId === cover.ownerId;
    return owned && versionId ? [{ ...cover, versionId }] : [];
  });
  if (!located.length) return found;

  const byVersion = await getImagesForModelVersionCache([
    ...new Set(located.map((cover) => cover.versionId)),
  ]);
  for (const cover of located) {
    const image = byVersion[cover.versionId]?.images.find(
      (candidate) => candidate.id === cover.coverId
    );
    if (image) found.set(cover.modelId, image);
  }
  return found;
}

/** The creator's own published images on every version of the model, for the cover pickers. */
export async function getCoverCandidates({ modelId }: { modelId: number }) {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId },
    select: { id: true },
    orderBy: { index: 'asc' },
  });
  if (!versions.length) return [];
  const byVersion = await getImagesForModelVersionCache(versions.map((version) => version.id));
  return versions.flatMap((version) =>
    (byVersion[version.id]?.images ?? []).map(({ id, url, type, metadata, nsfwLevel }) => ({
      id,
      url,
      type,
      metadata,
      nsfwLevel,
      modelVersionId: version.id,
    }))
  );
}
