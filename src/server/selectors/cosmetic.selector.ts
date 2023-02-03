import { TextProps } from '@mantine/core';
import { Prisma } from '@prisma/client';

export const simpleCosmeticSelect = Prisma.validator<Prisma.CosmeticSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  source: true,
  data: true,
});

const simpleUser = Prisma.validator<Prisma.CosmeticArgs>()({
  select: simpleCosmeticSelect,
});

export type SimpleCosmetic = Prisma.CosmeticGetPayload<typeof simpleUser>;

export type BadgeCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  data: { url?: string };
  obtainedAt: Date;
};
export type NamePlateCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  obtainedAt: Date;
  data: Pick<TextProps, 'variant' | 'color'> & {
    gradient?: {
      from: string;
      to: string;
      deg?: number;
    };
  };
};
