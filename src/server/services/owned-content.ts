import { dbWrite } from '~/server/db/client';

/**
 * Whether every listed model, image and article belongs to `ownerId`. Read on the primary: the
 * answer gates a write, and an item posted or transferred moments ago is the likeliest one asked.
 */
export async function ownsAllContent({
  ownerId,
  imageIds = [],
  modelIds = [],
  articleIds = [],
}: {
  ownerId: number;
  imageIds?: number[];
  modelIds?: number[];
  articleIds?: number[];
}) {
  const unique = (ids: number[]) => [...new Set(ids)];
  const where = (ids: number[]) => ({ id: { in: unique(ids) }, userId: ownerId });
  const select = { id: true } as const;
  const [images, models, articles] = await Promise.all([
    // primary: gates a write (see above).
    imageIds.length ? dbWrite.image.findMany({ where: where(imageIds), select }) : [],
    // primary: gates a write (see above).
    modelIds.length ? dbWrite.model.findMany({ where: where(modelIds), select }) : [],
    // primary: gates a write (see above).
    articleIds.length ? dbWrite.article.findMany({ where: where(articleIds), select }) : [],
  ]);
  return (
    images.length === unique(imageIds).length &&
    models.length === unique(modelIds).length &&
    articles.length === unique(articleIds).length
  );
}
