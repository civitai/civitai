import { Prisma } from '@prisma/client';
import type { TextProps } from '@mantine/core';
import type { CosmeticEntity, MediaType } from '~/shared/utils/prisma/enums';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';

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
  /**
   * Optional because it is selected per query rather than by `simpleCosmetic`:
   * `getUserCosmetics` asks for it so the sticker tray can filter to your own
   * without a second procedure. Widening the shared selector would push it into
   * the shop reads, which filter on `createdById` server-side and deliberately
   * do not ship it.
   *
   * Present on every cosmetic TYPE that `getUserCosmetics` returns — badges and
   * decorations carry it too, not only stickers — but on no other procedure.
   */
  createdById?: number | null;
};

export type BadgeCosmetic = Omit<SimpleCosmetic, 'data'> & {
  data: { url?: string; animated?: boolean };
  entityImage?: ImageProps;
};
export type NamePlateCosmetic = Omit<SimpleCosmetic, 'data' | 'videoUrl'> & {
  data: Pick<TextProps, 'variant' | 'color'> & {
    gradient?: {
      from: string;
      to: string;
      deg?: number;
    };
  };
};

export type ContentDecorationCosmetic = Omit<SimpleCosmetic, 'data' | 'videoUrl'> & {
  entityImage?: ImageProps & { entityId: number; entityType: string };
  data: {
    type?: 'holiday-frame';
    lights?: number;
    brightness?: number;
    color?: string;
    url?: string;
    offset?: string;
    // Per-side fit adjustment for creator-shop avatar decorations (see
    // decorationFrameStyle); wins over the legacy uniform `offset`.
    offsets?: { top: number; right: number; bottom: number; left: number };
    crop?: string;
    cssFrame?: string;
    glow?: boolean;
    texture?: { url: string; size: { width: number; height: number } };
  };
};
export type ProfileBackgroundCosmetic = BadgeCosmetic & {
  data: { textColor?: string; backgroundColor?: string; offset?: string; type?: MediaType };
};

export type StickerCosmetic = Omit<SimpleCosmetic, 'data'> & {
  data: { slug: string; url: string; animated?: boolean; uses?: number; pricePerUse?: number };
};

export type WithClaimKey<T> = T & { claimKey: string };
