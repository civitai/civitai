import { Badge, Group, MantineSize, Text, useMantineTheme } from '@mantine/core';
import { IconUpload, IconUsers, IconDownload, IconChecks } from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
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

type Props = {
  followers?: number;
  ratingValue?: number;
  uploads?: number;
  favorites?: number;
  downloads?: number;
  answers?: number;
  username?: string | null;
  size?: MantineSize;
  colorOverrides?: { textColor?: string; backgroundColor?: string };
};
