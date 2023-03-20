import { ModelStatus, Prisma } from '@prisma/client';
import { TagSort } from '~/server/common/enums';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetTagsInput } from '~/server/schema/tag.schema';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await dbRead.$queryRaw<{ id: number; name: string; count: number }>`
    SELECT "public"."Tag"."id",
    "public"."Tag"."name",
    (
      SELECT COUNT(*) AS "_aggr_count_tagsOnModels"
      FROM "public"."TagsOnModels"
      WHERE ("public"."TagsOnModels"."modelId", "public"."TagsOnModels"."tagId") IN (
        SELECT "t0"."modelId", "t0"."tagId"
        FROM "public"."TagsOnModels" AS "t0" INNER JOIN "public"."Model" AS "j0" ON ("j0"."id") = ("t0"."modelId")
        WHERE "j0"."status" = 'Published'
          AND "t0"."modelId" IS NOT NULL
          AND "t0"."tagId" = "public"."Tag"."id"
      )
    ) as count
    FROM "public"."Tag"
    WHERE "public"."Tag"."name" ILIKE ${name}
    LIMIT 1 OFFSET 0
  `;
};

export const getTags = async <TSelect extends Prisma.TagSelect = Prisma.TagSelect>({
  select,
  take,
  skip,
  entityType,
  query,
  modelId,
  not,
  unlisted,
  categories,
  sort,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  select: TSelect;
  take?: number;
  skip?: number;
}) => {
  const where: Prisma.TagWhereInput = {
    name: query ? { startsWith: query } : undefined,
    target: { hasSome: entityType },
    tagsOnModels: modelId ? { some: { modelId } } : undefined,
    id: not ? { notIn: not } : undefined,
    unlisted,
    isCategory: categories,
  };

  const items = await dbRead.tag.findMany({
    take,
    skip,
    select,
    where,
    orderBy: [
      ...(sort === TagSort.MostImages
        ? [{ rank: { imageCountAllTimeRank: 'asc' } as const }]
        : [{ rank: { modelCountAllTimeRank: 'asc' } as const }]),
    ],
  });
  const count = await dbRead.tag.count({ where });

  return { items, count };
};
