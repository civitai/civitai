import { Prisma } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetTagsInput } from '~/server/schema/tag.schema';

export const getTagWithModelCount = async ({ name }: { name: string }) => {
  return await prisma.tag.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          tagsOnModels: true,
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
}: Partial<GetTagsInput> & {
  select: TSelect;
  take?: number;
  skip?: number;
}) => {
  const where: Prisma.TagWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    target: entityType,
    tagsOnModels: modelId ? { some: { modelId } } : undefined,
  };

  const items = await prisma.tag.findMany({
    take,
    skip,
    select,
    where,
  });
  const count = await prisma.tag.count({ where });

  return { items, count };
};
