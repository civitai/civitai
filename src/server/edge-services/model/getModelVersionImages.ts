import { NsfwLevel, Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';

type ImagesForModelVersions = {
  id: number;
  userId: number;
  name: string;
  url: string;
  nsfw: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  modelVersionId: number;
  tags: number[];
  // meta?: Prisma.JsonValue;
};

export const getModelVersionImages = async ({
  modelVersionIds,
  imagesPerVersion = 10,
}: {
  modelVersionIds: number[];
  imagesPerVersion?: number;
}) => {
  if (!modelVersionIds.length) return [];
  // const showNsfw = getShowNsfw(browsingMode, currentUser);

  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`p."modelVersionId" IN (${Prisma.join(modelVersionIds)})`,
    Prisma.sql`i."needsReview" = false`,
  ];
  // if (!currentUser?.id) {
  //   imageWhere.push(Prisma.sql`(i."nsfw" = 'None' OR i."nsfw" = 'Soft')`);
  // } else if (!showNsfw) imageWhere.push(Prisma.sql`i."nsfw" = 'None'`);

  const images = await dbRead.$queryRaw<ImagesForModelVersions[]>`
    WITH targets AS (
      SELECT
        id,
        "modelVersionId"
      FROM (
        SELECT
          i.id,
          p."modelVersionId",
          row_number() OVER (PARTITION BY p."modelVersionId" ORDER BY i."postId", i.index) row_num
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
        WHERE ${Prisma.join(imageWhere, ' AND ')}
      ) ranked
      WHERE ranked.row_num <= ${imagesPerVersion}
    )
    SELECT
      i.id,
      i."userId",
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      t."modelVersionId",
      ARRAY(SELECT toi."tagId" FROM "TagsOnImage" toi WHERE toi."imageId" = i.id) as tags
    FROM targets t
    JOIN "Image" i ON i.id = t.id
    ORDER BY i."index"
  `;

  return images;

  // const tags = await dbRead.tagsOnImage.findMany({})

  // return images.map((x) => ({ ...x, tags: [] }));

  // const AND: Prisma.Enumerable<Prisma.ImageWhereInput> = [
  //   {
  //     post: { modelVersionId: { in: modelVersionIds } },
  //     needsReview: false,
  //     scannedAt: { not: null },
  //   },
  // ];

  // if (!currentUser?.id) AND.push({ OR: [{ nsfw: 'None' }, { nsfw: 'Soft' }] });
  // else if (!showNsfw) AND.push({ nsfw: 'None' });

  // const images = await dbRead.image.findMany({
  //   where: { AND },
  //   select: {
  //     id: true,
  //     height: true,
  //     width: true,
  //     name: true,
  //     nsfw: true,
  //     url: true,
  //     hash: true,
  //     userId: true,
  //     tags: { select: { tagId: true } },
  //     post: { select: { modelVersionId: true } },
  //   },
  //   orderBy: { index: 'asc' },
  // });

  // return images.map(({ post, tags, ...image }) => ({
  //   ...image,
  //   modelVersionId: post?.modelVersionId,
  //   tags: tags.map((x) => x.tagId),
  // }));
};
