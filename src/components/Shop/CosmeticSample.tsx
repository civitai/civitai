import { MantineSize, Text } from '@mantine/core';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  NamePlateCosmetic,
  ProfileBackgroundCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { CosmeticGetById } from '~/types/router';

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
}: {
  cosmetic: Pick<CosmeticGetById, 'id' | 'data' | 'type' | 'name'>;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const values = cosmeticSampleSizeMap[size];

  switch (cosmetic.type) {
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
      const decorationData = cosmetic.data as BadgeCosmetic['data'];
      if (!decorationData.url) return null;

      return (
        <div style={{ width: values.badgeSize }}>
          <EdgeMedia src={decorationData.url} alt={cosmetic.name} />
        </div>
      );
    case CosmeticType.ContentDecoration:
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
    case CosmeticType.NamePlate:
      const data = cosmetic.data as NamePlateCosmetic['data'];
      return (
        <Text fw="bold" {...data} size={values.textSize}>
          Sample Text
        </Text>
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
