import type { MantineSize } from '@mantine/core';
import type { CSSProperties } from 'react';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { NamePlateText } from '~/components/User/NamePlateText';
import type {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  StickerCosmetic,
  NamePlateCosmetic,
  ProfileBackgroundCosmetic,
} from '~/server/selectors/cosmetic.selector';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';
import type { CosmeticGetById } from '~/types/router';

const cosmeticSampleSizeMap: Record<
  'sm' | 'md' | 'lg',
  { badgeSize: number; textSize: MantineSize; avatarSize: MantineSize }
> = {
  sm: { badgeSize: 50, textSize: 'sm', avatarSize: 'md' },
  md: { badgeSize: 80, textSize: 'md', avatarSize: 'xl' },
  lg: { badgeSize: 120, textSize: 'lg', avatarSize: 'xl' },
};

export const CosmeticSample = ({
  cosmetic,
  size = 'sm',
  lazy,
}: {
  cosmetic: Pick<CosmeticGetById, 'id' | 'data' | 'type' | 'name'>;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Defer the fetch until the sample is near the viewport. Opt-in, because most
   * callers are pickers and modals showing a handful of samples the user asked
   * for; the shop grids render a whole section at once and are the reason this
   * exists. Above-the-fold cards are unaffected — a lazy image already in the
   * viewport is fetched immediately.
   */
  lazy?: boolean;
}) => {
  const values = cosmeticSampleSizeMap[size];
  const loading = lazy ? ('lazy' as const) : undefined;

  switch (cosmetic.type) {
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
      const decorationData = cosmetic.data as BadgeCosmetic['data'];
      if (!decorationData.url) return null;

      return (
        <div style={{ width: values.badgeSize }}>
          <EdgeMedia
            src={decorationData.url}
            alt={cosmetic.name}
            width={values.badgeSize}
            loading={loading}
            optimized
          />
        </div>
      );
    case CosmeticType.ContentDecoration:
      if (isEventDecorationData(cosmetic.data))
        return <EventDecorationSample decoration={cosmetic.data} size={size} />;
      const contentDecorationData = cosmetic.data as ContentDecorationCosmetic['data'];
      if (!contentDecorationData.url && !contentDecorationData.cssFrame) return null;

      return (
        <div style={{ width: values.badgeSize }}>
          <FeedCard
            className="!m-0"
            aspectRatio="square"
            frameDecoration={cosmetic as ContentDecorationCosmetic}
          >
            <div className="size-full bg-gray-100 dark:bg-dark-7" />
          </FeedCard>
        </div>
      );
    case CosmeticType.Sticker:
      const stickerData = cosmetic.data as StickerCosmetic['data'];
      if (!stickerData.url) return null;

      return (
        <EdgeMedia
          src={stickerData.url}
          alt={stickerData.slug ? `:${stickerData.slug}:` : cosmetic.name}
          width={values.badgeSize}
          anim={stickerData.animated}
          loading={loading}
          optimized
          style={{ width: values.badgeSize, height: values.badgeSize, objectFit: 'contain' }}
        />
      );
    case CosmeticType.NamePlate:
      const data = cosmetic.data as NamePlateCosmetic['data'];
      return (
        <NamePlateText fw="bold" nameplate={data} size={values.textSize}>
          Sample Text
        </NamePlateText>
      );
    case CosmeticType.ProfileBackground:
      const backgroundData = cosmetic.data as ProfileBackgroundCosmetic['data'];
      if (!backgroundData.url) return null;

      return (
        <div
          style={{
            height: values.badgeSize,
            width: '100%',
            overflow: 'hidden',
            borderRadius: 10,
          }}
        >
          <EdgeMedia
            src={backgroundData.url}
            alt={cosmetic.name}
            type={backgroundData.type}
            anim={true}
            width={450}
            optimized
            // Inert when `type` is video: EdgeMedia spreads imgProps into EdgeImage only,
            // so EdgeVideo never sees this. Its poster is eager regardless, and the video is
            // preload="none" except on Safari, which forces 'auto'.
            loading={loading}
            style={{
              objectFit: 'cover',
              // objectPosition: 'right bottom',
              width: '100%',
              height: '100%',
            }}
            wrapperProps={{
              style: { height: '100%' },
            }}
            contain
          />
        </div>
      );
    default:
      return null;
  }
};

// A hat's sample card. At the largest size the hat is worn at full feed size, so it reads as the hat
// you get; smaller samples shrink it with the card. Square, like the frame samples beside it.
const HAT_SAMPLE_WIDTH = { sm: 64, md: 96, lg: 140 } as const;
// Room past the card's top-left corner for the hat to hang into, as on a feed card.
const HAT_SAMPLE_ROOM = 28;

/**
 * An event decoration (a hat) worn on a skeleton feed card, so it reads as a hat on content rather
 * than art floating beside nothing. Drawn by the feed's own wrapper; it does not grow on hover.
 */
function EventDecorationSample({
  decoration,
  size,
}: {
  decoration: EventDecorationData;
  size: 'sm' | 'md' | 'lg';
}) {
  const width = HAT_SAMPLE_WIDTH[size];
  return (
    <div
      style={
        {
          // Matched on the right, so the card itself sits centred where the sample is placed.
          paddingInline: HAT_SAMPLE_ROOM,
          paddingTop: HAT_SAMPLE_ROOM,
          '--event-decoration-allowance': `${HAT_SAMPLE_ROOM}px`,
          '--event-decoration-grow': 1,
        } as CSSProperties
      }
      data-testid="hat-sample"
    >
      <div style={{ width }}>
        <TwCosmeticWrapper
          eventDecoration={decoration}
          cardWidth={size === 'lg' ? undefined : width}
        >
          <div className="flex aspect-square w-full flex-col justify-end gap-1.5 rounded-md bg-gray-2 p-[8%] dark:bg-dark-4">
            <div className="h-2 w-3/4 rounded-full bg-gray-3 dark:bg-dark-3" />
            <div className="h-2 w-1/2 rounded-full bg-gray-3 dark:bg-dark-3" />
          </div>
        </TwCosmeticWrapper>
      </div>
    </div>
  );
}
