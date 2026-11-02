import { dbRead } from '~/server/db/client';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import type { ChallengeDetail } from '~/server/schema/challenge.schema';
import { pickPreviewImage } from '~/shared/utils/resource-preview';

export type EligibleModel = ChallengeDetail['models'][number];

/** With `viewerLevel`, each cover is the first image that level may see; without, the first image. */
export async function getEligibleModels(
  versionIds: number[],
  { viewerLevel }: { viewerLevel?: number } = {}
): Promise<EligibleModel[]> {
  if (!versionIds.length) return [];

  // Loaded on demand: the model service's import graph is large.
  const { holdShowcaseImages } = await import('~/server/services/model.service');
  const [versions, imageCache] = await Promise.all([
    dbRead.modelVersion.findMany({
      where: { id: { in: versionIds } },
      select: {
        id: true,
        name: true,
        baseModel: true,
        model: { select: { id: true, name: true } },
      },
    }),
    // Held for every viewer: a challenge's models are the same for everyone.
    imagesForModelVersionsCache
      .fetch(versionIds)
      .then((byVersion) => holdShowcaseImages(byVersion)),
  ]);

  return versions.map((v) => {
    const images = imageCache[v.id]?.images ?? [];
    const img =
      (viewerLevel === undefined ? images[0] : pickPreviewImage(images, viewerLevel)) ?? null;
    return {
      id: v.model.id,
      name: v.model.name,
      versionId: v.id,
      versionName: v.name,
      baseModel: v.baseModel,
      image: img
        ? {
            id: img.id,
            url: img.url,
            nsfwLevel: img.nsfwLevel,
            hash: img.hash,
            width: img.width,
            height: img.height,
            type: img.type,
          }
        : null,
    };
  });
}
