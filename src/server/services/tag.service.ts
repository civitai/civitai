import { Prisma } from '@prisma/client';
import { prisma } from '~/server/db/client';
import { GetTagsInput } from '~/server/schema/tag.schema';

export const getTags = <TSelect extends Prisma.TagSelect = Prisma.TagSelect>({
  limit,
  query,
  page,
  select,
}: GetTagsInput & { select: TSelect }) => {
  return prisma.tag.findMany({
    take: limit,
    skip: page ? (page - 1) * (limit ?? 0) : undefined,
    select,
    where: {
      name: query
        ? {
            contains: query,
            mode: 'insensitive',
          }
        : undefined,
    },
  });
};
