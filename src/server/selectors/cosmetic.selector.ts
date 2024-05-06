import { CSSObject, TextProps } from '@mantine/core';
import { CosmeticEntity, Prisma, MediaType } from '@prisma/client';
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

export type SimpleCosmetic = Omit<
  Prisma.CosmeticGetPayload<typeof simpleCosmetic>,
  'description'
> & {
  description?: string | null;
  equippedToId?: number | null;
  equippedToType?: CosmeticEntity | null;
  forId?: number | null;
  forType?: CosmeticEntity | null;
  obtainedAt?: Date;
  inUse?: boolean;
};

export type BadgeCosmetic = Omit<SimpleCosmetic, 'data'> & {
  data: { url?: string; animated?: boolean };
  entityImage?: ImageProps;
};
export type NamePlateCosmetic = Omit<SimpleCosmetic, 'data'> & {
  data: Pick<TextProps, 'variant' | 'color'> & {
    gradient?: {
      from: string;
      to: string;
      deg?: number;
    };
  };
};
export type ContentDecorationCosmetic = Omit<SimpleCosmetic, 'data'> & {
  entityImage?: ImageProps & { entityId: number; entityType: string };
  data: {
    url?: string;
    offset?: string;
    crop?: string;
    cssFrame?: string;
    glow?: boolean;
    texture?: { url: string; size: { width: number; height: number } };
  };
};
export type ProfileBackgroundCosmetic = BadgeCosmetic & {
  data: { textColor?: string; backgroundColor?: string; offset?: string; type?: MediaType };
};

export type WithClaimKey<T> = T & { claimKey: string };
