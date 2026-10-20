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
 * The chosen covers, by image id. A cover already among the shown versions' images is taken from
 * there; one on another version comes through the same cached, creator-only version-image read, so
 * it carries the same shape and the same filters. A dangling id is simply absent.
 */
export async function getCoverImages({
  coverIds,
  modelVersionImages,
  sameVersionOnly,
  shownVersionIds,
}: {
  coverIds: (number | null)[];
  modelVersionImages: Record<number, { images: ImagesForModelVersions[] }>;
  sameVersionOnly: boolean;
  shownVersionIds: number[];
}) {
  const wanted = new Set(coverIds.filter(isDefined));
  const found = new Map<number, ImagesForModelVersions>();
  if (!wanted.size) return found;

  const collect = (entries: { images: ImagesForModelVersions[] }[]) => {
    for (const entry of entries)
      for (const image of entry.images) if (wanted.has(image.id)) found.set(image.id, image);
  };
  collect(Object.values(modelVersionImages));

  const missing = [...wanted].filter((id) => !found.has(id));
  if (!missing.length || sameVersionOnly) return found;

  const rows = await dbRead.image.findMany({
    where: { id: { in: missing } },
    select: { post: { select: { modelVersionId: true } } },
  });
  const otherVersionIds = [
    ...new Set(rows.map((row) => row.post?.modelVersionId).filter(isDefined)),
  ].filter((id) => !shownVersionIds.includes(id));
  if (otherVersionIds.length)
    collect(Object.values(await getImagesForModelVersionCache(otherVersionIds)));

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
