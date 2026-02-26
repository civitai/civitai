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

export function UserStatBadgesV2({
  followers,
  favorites,
  uploads,
  downloads,
  generations,
  answers,
  reactions,
}: Props) {
  return (
    <Group gap={4} wrap="nowrap">
      {uploads != null ? (
        <BadgedIcon icon={<IconUpload size={18} color="white" />} label="Uploads" value={uploads} />
      ) : null}
      {reactions != null ? (
        <BadgedIcon
          icon={<IconMoodSmile size={18} color="white" />}
          label="Reactions"
          value={reactions}
        />
      ) : null}
      {followers != null ? (
        <BadgedIcon
          icon={<IconUsers size={18} color="white" />}
          label="Followers"
          value={followers}
        />
      ) : null}
      {favorites != null ? (
        <BadgedIcon
          icon={<ThumbsUpIcon size={18} color="white" />}
          label="Likes"
          value={favorites}
        />
      ) : null}
      {downloads != null ? (
        <BadgedIcon
          icon={<IconDownload size={18} color="white" />}
          label="Downloads"
          value={downloads}
        />
      ) : null}
      {generations != null ? (
        <BadgedIcon
          icon={<IconBrush size={18} color="white" />}
          label="Generations"
          value={generations}
        />
      ) : null}
      {answers != null && answers > 0 ? (
        <BadgedIcon icon={<IconChecks size={18} color="white" />} label="Answers" value={answers} />
      ) : null}
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
