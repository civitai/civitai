import { TextProps } from '@mantine/core';
import { Prisma } from '@prisma/client';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';

export const simpleCosmeticSelect = Prisma.validator<Prisma.CosmeticSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  source: true,
  data: true,
});

const simpleCosmetic = Prisma.validator<Prisma.CosmeticDefaultArgs>()({
  select: simpleCosmeticSelect,
});

export type SimpleCosmetic = Prisma.CosmeticGetPayload<typeof simpleCosmetic>;

export type BadgeCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  data: { url?: string; animated?: boolean };
  obtainedAt: Date;
  inUse?: boolean;
  entityImage?: ImageProps;
};
export type NamePlateCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  obtainedAt: Date;
  inUse?: boolean;
  data: Pick<TextProps, 'variant' | 'color'> & {
    gradient?: {
      from: string;
      to: string;
      deg?: number;
    };
  };
};
export type ContentDecorationCosmetic = BadgeCosmetic & { data: { offset?: string } };
export type ProfileBackgroundCosmetic = BadgeCosmetic & {
  data: { textColor?: string; backgroundColor?: string; offset?: string };
};
