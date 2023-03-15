import { ModelStatus, Prisma } from '@prisma/client';
import { TagSort } from '~/server/common/enums';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetTagsInput } from '~/server/schema/tag.schema';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await dbRead.tag.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
    },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          tagsOnModels: { where: { model: { status: ModelStatus.Published } } },
        },
      },
    },
  });
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
    name: query ? { startsWith: query, mode: 'insensitive' } : undefined,
    target: { hasSome: entityType },
    tagsOnModels: modelId ? { some: { modelId } } : undefined,
    id: not ? { notIn: not } : undefined,
    unlisted,
    isCategory: categories,
  };

  const orderBy: Prisma.Enumerable<Prisma.TagOrderByWithRelationInput> = [];
  if (sort === TagSort.MostImages) orderBy.push({ rank: { imageCountAllTimeRank: 'asc' } });
  else if (sort === TagSort.MostModels) orderBy.push({ rank: { modelCountAllTimeRank: 'asc' } });
  else if (sort === TagSort.MostPosts) orderBy.push({ rank: { postCountAllTimeRank: 'asc' } });

  const items = await dbRead.tag.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });
  const count = await dbRead.tag.count({ where });

  return { items, count };
};
