import { Group, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconUser } from '@tabler/icons-react';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

import { abbreviateNumber } from '~/utils/number-helpers';

const UserStat = ({
  value,
  icon,
  subtext,
}: {
  value: number | string;
  icon: React.ReactNode;
  subtext: string;
}) => {
  return (
    <Stack spacing={0} align="center">
      <Group spacing={2}>
        {icon}
        <Text size="md">{value}</Text>
      </Group>
      <Text tt="uppercase" color="dimmed" size={10} weight={510}>
        {subtext}
      </Text>
    </Stack>
  );
};
export function UserStats({ followers, downloads, favorites }: Props) {
  return (
    <Group spacing={0} align="center" position="apart" noWrap>
      {favorites != null && favorites !== 0 && (
        <UserStat
          value={abbreviateNumber(favorites)}
          icon={<ThumbsUpIcon size={16} />}
          subtext="Likes"
        />
      )}
      {followers != null && followers !== 0 && (
        <UserStat
          value={abbreviateNumber(followers)}
          icon={<IconUser size={16} />}
          subtext="Followers"
        />
      )}
      {downloads != null && downloads !== 0 && (
        <UserStat
          value={abbreviateNumber(downloads)}
          icon={<IconArrowDown size={16} />}
          subtext="Downloads"
        />
      )}
    </Group>
  );
}

type Props = {
  favorites?: number;
  followers?: number;
  downloads?: number;
};
