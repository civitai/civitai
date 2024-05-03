import { Badge, BadgeProps, Box, Group, MantineSize, Text, useMantineTheme } from '@mantine/core';
import {
  IconUpload,
  IconUsers,
  IconDownload,
  IconChecks,
  IconMoodSmile,
} from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { StatTooltip } from '~/components/Tooltips/StatTooltip';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import Image from 'next/image';

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

  return (
    <Group spacing={8} position="apart">
      <Badge
        size="lg"
        radius="xl"
        px={8}
        color="dark"
        sx={
          colorOverrides
            ? { backgroundColor: colorOverrides.backgroundColor ?? undefined }
            : undefined
        }
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      >
        <Group spacing="xs" noWrap>
          {uploads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Uploads" value={uploads} />}
              icon={<IconUpload size={14} />}
              sx={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" weight={600} inline>
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
              sx={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              size="lg"
              // @ts-ignore: transparent variant does work
              variant="transparent"
            >
              <Text size="xs" weight={600} inline>
                {abbreviateNumber(followers)}
              </Text>
            </IconBadge>
          ) : null}
          {favorites != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Likes" value={favorites} />}
              icon={<ThumbsUpIcon size={14} />}
              sx={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600} inline>
                {abbreviateNumber(favorites)}
              </Text>
            </IconBadge>
          ) : null}
          {downloads != null ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Downloads" value={downloads} />}
              icon={<IconDownload size={14} />}
              sx={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600} inline>
                {abbreviateNumber(downloads)}
              </Text>
            </IconBadge>
          ) : null}
          {answers != null && answers > 0 ? (
            <IconBadge
              p={0}
              tooltip={<StatTooltip label="Answers" value={answers} />}
              icon={<IconChecks size={14} />}
              sx={
                colorOverrides
                  ? { color: colorOverrides.textColor ?? theme.colors.gray[0] }
                  : undefined
              }
              // @ts-ignore: transparent variant does work
              variant="transparent"
              size="lg"
            >
              <Text size="xs" weight={600} inline>
                {abbreviateNumber(answers)}
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
  value: number | string;
  icon: React.ReactNode;
  textSize?: MantineSize;
} & Omit<BadgeProps, 'leftSection'>) => (
  <Group spacing={0} noWrap sx={{ position: 'relative' }}>
    <Box pos="relative" sx={{ zIndex: 2, overflow: 'hidden' }} h={32}>
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
    <IconBadge
      size={size}
      color="dark.6"
      // @ts-ignore
      variant="filled"
      sx={{
        paddingLeft: 16,
        marginLeft: -14,
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
      }}
      {...props}
    >
      <Text size={textSize} inline>
        {value}
      </Text>
    </IconBadge>
  </Group>
);

export function UserStatBadgesV2({
  followers,
  favorites,
  uploads,
  downloads,
  answers,
  reactions,
}: Props) {
  return (
    <Group spacing={4} noWrap>
      {uploads != null ? (
        <BadgedIcon
          icon={<IconUpload size={18} color="white" />}
          label="Uploads"
          value={abbreviateNumber(uploads)}
        />
      ) : null}
      {reactions != null ? (
        <BadgedIcon
          icon={<IconMoodSmile size={18} color="white" />}
          label="Reactions"
          value={abbreviateNumber(reactions)}
        />
      ) : null}
      {followers != null ? (
        <BadgedIcon
          icon={<IconUsers size={18} color="white" />}
          label="Followers"
          value={abbreviateNumber(followers)}
        />
      ) : null}
      {favorites != null ? (
        <BadgedIcon
          icon={<ThumbsUpIcon size={18} color="white" />}
          label="Likes"
          value={abbreviateNumber(favorites)}
        />
      ) : null}
      {downloads != null ? (
        <BadgedIcon
          icon={<IconDownload size={18} color="white" />}
          label="Downloads"
          value={abbreviateNumber(downloads)}
        />
      ) : null}
      {answers != null && answers > 0 ? (
        <BadgedIcon
          icon={<IconChecks size={18} color="white" />}
          label="Answers"
          value={abbreviateNumber(answers)}
        />
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
  answers?: number | null;
  reactions?: number | null;
  username?: string | null;
  size?: MantineSize;
  colorOverrides?: { textColor?: string; backgroundColor?: string };
};
