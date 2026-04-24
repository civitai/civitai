import type { BadgeProps, MantineSize } from '@mantine/core';
import {
  Badge,
  Box,
  Group,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import {
  IconUpload,
  IconUsers,
  IconDownload,
  IconChecks,
  IconMoodSmile,
  IconBrush,
} from '@tabler/icons-react';
import Image from 'next/image';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';
import { AnimatedCount } from '~/components/Metrics';
import { StatTooltip } from '~/components/Tooltips/StatTooltip';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

export function UserStatBadges({
  followers,
  favorites,
  uploads,
  downloads,
  answers,
  username,
  colorOverrides,
}: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  return (
    <Group gap={8} justify="space-between">
      <Badge
        size="lg"
        radius="xl"
        px={8}
        color="dark"
        style={
          colorOverrides
            ? { backgroundColor: colorOverrides.backgroundColor ?? undefined }
            : undefined
        }
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
      >
        <Group gap="xs" wrap="nowrap">
          {uploads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Uploads" value={uploads} />}
              icon={<IconUpload size={14} />}
              style={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" fw={600} inline>
                <AnimatedCount value={uploads} />
              </Text>
            </IconBadge>
          ) : null}
          {followers != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Followers" value={followers} />}
              href={username ? `/user/${username}/followers` : undefined}
              icon={<IconUsers size={14} />}
              style={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" fw={600} inline>
                <AnimatedCount value={followers} />
              </Text>
            </IconBadge>
          ) : null}
          {favorites != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Likes" value={favorites} />}
              icon={<ThumbsUpIcon size={14} />}
              style={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" fw={600} inline>
                <AnimatedCount value={favorites} />
              </Text>
            </IconBadge>
          ) : null}
          {downloads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Downloads" value={downloads} />}
              icon={<IconDownload size={14} />}
              style={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" fw={600} inline>
                <AnimatedCount value={downloads} />
              </Text>
            </IconBadge>
          ) : null}
          {answers != null && answers > 0 ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Answers" value={answers} />}
              icon={<IconChecks size={14} />}
              style={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" fw={600} inline>
                <AnimatedCount value={answers} />
              </Text>
            </IconBadge>
          ) : null}
        </Group>
      </Badge>
    </Group>
  );
}

const BadgedIcon = ({
  label,
  icon,
  value,
  size = 'md',
  textSize = 'xs',
  ...props
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  textSize?: MantineSize;
} & Omit<BadgeProps, 'leftSection'>) => (
  <Group gap={0} wrap="nowrap" className="relative">
    <Tooltip label={label}>
      <Box pos="relative" style={{ zIndex: 2, overflow: 'hidden' }} h={32}>
        <Image src="/images/base-badge.png" alt={`${label} - ${value}`} width={32} height={32} />
        <Box
          style={{
            top: '50%',
            left: '50%',
            position: 'absolute',
            transform: 'translate(-50%, -50%)',
          }}
        >
          {icon}
        </Box>
      </Box>
    </Tooltip>
    <IconBadge
      size={size}
      color="dark.6"
      variant="filled"
      className="ml-[-14px] rounded-l-none !pl-4"
      {...props}
    >
      <Text size={textSize} fw="bold" inline title={numberWithCommas(value ?? 0)}>
        <AnimatedCount value={value ?? 0} />
      </Text>
    </IconBadge>
  </Group>
);

export type UserStatKey =
  | 'uploads'
  | 'followers'
  | 'likes'
  | 'downloads'
  | 'reactions'
  | 'generations'
  | 'answers';

export type UserStats = Partial<Record<UserStatKey, number | null | undefined>>;

type UserStatBadgeConfig = {
  key: UserStatKey;
  label: string;
  icon: React.ReactElement;
  /** Only render when the value is at least this. Defaults to 0 (all non-null values render). */
  minValue?: number;
};

// Render order matches this array.
const userStatBadges: ReadonlyArray<UserStatBadgeConfig> = [
  { key: 'uploads', label: 'Uploads', icon: <IconUpload size={18} color="white" /> },
  { key: 'reactions', label: 'Reactions', icon: <IconMoodSmile size={18} color="white" /> },
  { key: 'followers', label: 'Followers', icon: <IconUsers size={18} color="white" /> },
  { key: 'likes', label: 'Likes', icon: <ThumbsUpIcon size={18} color="white" /> },
  { key: 'downloads', label: 'Downloads', icon: <IconDownload size={18} color="white" /> },
  { key: 'generations', label: 'Generations', icon: <IconBrush size={18} color="white" /> },
  { key: 'answers', label: 'Answers', icon: <IconChecks size={18} color="white" />, minValue: 1 },
];

export function UserStatBadgesV2({
  stats,
  displayStats,
}: {
  stats?: UserStats;
  /** Restricts which stats are rendered. When omitted, all non-null entries in `stats` render. */
  displayStats?: readonly string[];
}) {
  const displayFilter = displayStats ? new Set(displayStats) : null;
  return (
    <Group gap={4} wrap="nowrap">
      {userStatBadges.map(({ key, label, icon, minValue = 0 }) => {
        if (displayFilter && !displayFilter.has(key)) return null;
        const value = stats?.[key];
        if (value == null || value < minValue) return null;
        return <BadgedIcon key={key} icon={icon} label={label} value={value} />;
      })}
    </Group>
  );
}

type Props = {
  followers?: number | null;
  ratingValue?: number | null;
  uploads?: number | null;
  favorites?: number | null;
  downloads?: number | null;
  generations?: number | null;
  answers?: number | null;
  reactions?: number | null;
  username?: string | null;
  size?: MantineSize;
  colorOverrides?: { textColor?: string; backgroundColor?: string };
};
