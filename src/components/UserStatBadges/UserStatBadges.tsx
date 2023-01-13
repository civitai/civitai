import { Group, MantineSize, Rating, Text, useMantineTheme } from '@mantine/core';
import {
  IconStar,
  IconUpload,
  IconUsers,
  IconHeart,
  IconDownload,
  IconChecks,
} from '@tabler/icons';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';

const mapBadgeTextIconSize: Record<MantineSize, { textSize: MantineSize; iconSize: number }> = {
  xs: { textSize: 'xs', iconSize: 12 },
  sm: { textSize: 'xs', iconSize: 14 },
  md: { textSize: 'sm', iconSize: 14 },
  lg: { textSize: 'sm', iconSize: 16 },
  xl: { textSize: 'md', iconSize: 18 },
};

export function UserStatBadges({
  rating,
  followers,
  favorite,
  uploads,
  downloads,
  answers,
  size = 'lg',
}: Props) {
  const theme = useMantineTheme();
  const { textSize, iconSize } = mapBadgeTextIconSize[size];

  return (
    <Group spacing="xs">
      {rating != null ? (
        <IconBadge
          tooltip="Average Rating"
          sx={{ userSelect: 'none' }}
          size={size}
          icon={
            <Rating
              size="xs"
              value={rating.value}
              readOnly
              emptySymbol={
                theme.colorScheme === 'dark' ? (
                  <IconStar size={iconSize} fill="rgba(255,255,255,.3)" color="transparent" />
                ) : undefined
              }
            />
          }
          variant={theme.colorScheme === 'dark' && rating.count > 0 ? 'filled' : 'light'}
        >
          <Text size={textSize} color={rating.count > 0 ? undefined : 'dimmed'}>
            {abbreviateNumber(rating.count)}
          </Text>
        </IconBadge>
      ) : null}
      {uploads != null ? (
        <IconBadge
          tooltip="Uploads"
          icon={<IconUpload size={iconSize} />}
          color="gray"
          size={size}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        >
          <Text size={textSize}>{abbreviateNumber(uploads)}</Text>
        </IconBadge>
      ) : null}
      {followers != null ? (
        <IconBadge
          tooltip="Followers"
          icon={<IconUsers size={iconSize} />}
          color="gray"
          size={size}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        >
          <Text size={textSize}>{abbreviateNumber(followers)}</Text>
        </IconBadge>
      ) : null}
      {favorite != null ? (
        <IconBadge
          tooltip="Favorites"
          icon={<IconHeart size={iconSize} />}
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          size={size}
        >
          <Text size={textSize}>{abbreviateNumber(favorite)}</Text>
        </IconBadge>
      ) : null}
      {downloads != null ? (
        <IconBadge
          tooltip="Downloads"
          icon={<IconDownload size={iconSize} />}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          size={size}
        >
          <Text size={textSize}>{abbreviateNumber(downloads)}</Text>
        </IconBadge>
      ) : null}
      {answers != null && answers > 0 ? (
        <IconBadge
          tooltip="Answers"
          icon={<IconChecks size={iconSize} />}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          size={size}
        >
          <Text size={textSize}>{abbreviateNumber(answers)}</Text>
        </IconBadge>
      ) : null}
    </Group>
  );
}

type Props = {
  followers?: number;
  rating?: { value: number; count: number };
  ratingValue?: number;
  uploads?: number;
  favorite?: number;
  downloads?: number;
  answers?: number;
  size?: MantineSize;
};
