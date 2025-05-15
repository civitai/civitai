import { Group, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconBrush, IconUser } from '@tabler/icons-react';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

const UserStat = ({
  value,
  icon,
  subtext,
}: {
  value: number;
  icon: React.ReactNode;
  subtext: string;
}) => {
  return (
    <Stack gap={0} align="center">
      <Group gap={2}>
        {icon}
        <Text size="md" title={numberWithCommas(value ?? 0)}>
          {abbreviateNumber(value ?? 0)}
        </Text>
      </Group>
      <Text tt="uppercase" color="dimmed" fz={10} weight={510}>
        {subtext}
      </Text>
    </Stack>
  );
};
export function UserStats({ followers, downloads, favorites, generations }: Props) {
  return (
    <Group gap={0} align="center" justify="space-between" wrap="nowrap">
      {followers != null && followers !== 0 && (
        <UserStat value={followers} icon={<IconUser size={16} />} subtext="Followers" />
      )}
      {favorites != null && favorites !== 0 && (
        <UserStat value={favorites} icon={<ThumbsUpIcon size={16} />} subtext="Likes" />
      )}
      {downloads != null && downloads !== 0 && (
        <UserStat value={downloads} icon={<IconArrowDown size={16} />} subtext="Downloads" />
      )}
      {generations != null && generations !== 0 && (
        <UserStat value={generations} icon={<IconBrush size={16} />} subtext="Generations" />
      )}
    </Group>
  );
}

type Props = {
  favorites?: number;
  followers?: number;
  downloads?: number;
  generations?: number;
};
