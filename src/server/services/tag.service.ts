import { Prisma, TagTarget } from '@prisma/client';

import { prisma } from '~/server/db/client';

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
  target,
  query,
}: {
  select: TSelect;
  take?: number;
  skip?: number;
  target?: TagTarget;
  query?: string;
}) => {
  const where: Prisma.TagWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    target,
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
