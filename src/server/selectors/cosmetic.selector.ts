import { TextProps } from '@mantine/core';
import { CosmeticEntity, Prisma } from '@prisma/client';
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

export type SimpleCosmetic = Prisma.CosmeticGetPayload<typeof simpleCosmetic> & {
  equippedToId?: number | null;
  equippedToType?: CosmeticEntity | null;
  forId?: number | null;
  forType?: CosmeticEntity | null;
  obtainedAt?: Date;
  inUse?: boolean;
};

export type BadgeCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  data: { url?: string; animated?: boolean };
  entityImage?: ImageProps;
};
export type NamePlateCosmetic = Omit<SimpleCosmetic, 'data' | 'type'> & {
  data: Pick<TextProps, 'variant' | 'color'> & {
    gradient?: {
      from: string;
      to: string;
      deg?: number;
    };
  };
};
export type ContentDecorationCosmetic = BadgeCosmetic & {
  data: { offset?: string; crop?: string };
};
export type ProfileBackgroundCosmetic = BadgeCosmetic & {
  data: { textColor?: string; backgroundColor?: string; offset?: string };
};

export type WithClaimKey<T> = T & { claimKey: string };
