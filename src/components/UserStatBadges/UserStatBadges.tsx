import { Badge, Group, MantineSize, Rating, Text, useMantineTheme } from '@mantine/core';
import {
  IconStar,
  IconUpload,
  IconUsers,
  IconHeart,
  IconDownload,
  IconChecks,
} from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber, formatToLeastDecimals } from '~/utils/number-helpers';
import { StatTooltip } from '~/components/Tooltips/StatTooltip';

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
  username,
}: Props) {
  const theme = useMantineTheme();

  return (
    <Group spacing={8} position="apart">
      {rating != null ? (
        <IconBadge
          radius="xl"
          tooltip={
            <StatTooltip
              label="Average Rating"
              value={`${formatToLeastDecimals(rating.value)} (${rating.count})`}
            />
          }
          sx={{ userSelect: 'none' }}
          size="lg"
          px={8}
          icon={
            <Rating
              size="xs"
              value={rating.value}
              readOnly
              emptySymbol={
                theme.colorScheme === 'dark' ? (
                  <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
                ) : undefined
              }
            />
          }
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        >
          <Text size="xs" weight={600}>
            {abbreviateNumber(rating.count)}
          </Text>
        </IconBadge>
      ) : null}
      <Badge
        size="lg"
        color="gray"
        radius="xl"
        px={8}
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      >
        <Group spacing="xs" noWrap>
          {uploads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Uploads" value={uploads} />}
              icon={<IconUpload size={14} />}
              color="gray"
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" weight={600}>
                {abbreviateNumber(uploads)}
              </Text>
            </IconBadge>
          ) : null}
          {followers != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Followers" value={followers} />}
              href={username ? `/user/${username}/followers` : undefined}
              icon={<IconUsers size={14} />}
              color="gray"
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" weight={600}>
                {abbreviateNumber(followers)}
              </Text>
            </IconBadge>
          ) : null}
          {favorite != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Favorites" value={favorite} />}
              icon={<IconHeart size={14} />}
              color="gray"
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600}>
                {abbreviateNumber(favorite)}
              </Text>
            </IconBadge>
          ) : null}
          {downloads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Downloads" value={downloads} />}
              icon={<IconDownload size={14} />}
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600}>
                {abbreviateNumber(downloads)}
              </Text>
            </IconBadge>
          ) : null}
          {answers != null && answers > 0 ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Answers" value={answers} />}
              icon={<IconChecks size={14} />}
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600}>
                {abbreviateNumber(answers)}
              </Text>
            </IconBadge>
          ) : null}
        </Group>
      </Badge>
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
  username?: string | null;
  size?: MantineSize;
};
