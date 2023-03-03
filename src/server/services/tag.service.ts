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
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
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
