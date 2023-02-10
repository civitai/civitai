import { ModelStatus, Prisma } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetTagsInput } from '~/server/schema/tag.schema';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await prisma.tag.findFirst({
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
  orderBy,
  not,
  unlisted,
  categories,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  select: TSelect;
  take?: number;
  skip?: number;
  orderBy?: Prisma.TagFindManyArgs['orderBy'];
}) => {
  const where: Prisma.TagWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    target: entityType,
    tagsOnModels: modelId ? { some: { modelId } } : undefined,
    id: not ? { notIn: not } : undefined,
    unlisted,
    isCategory: categories,
  };

  const items = await prisma.tag.findMany({
    take,
    skip,
    select,
    where,
    orderBy,
  });
  const count = await prisma.tag.count({ where });

  return { items, count };
};
