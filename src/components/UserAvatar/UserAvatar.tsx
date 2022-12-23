import {
  Avatar,
  AvatarProps,
  BadgeProps,
  Group,
  MantineNumberSize,
  MantineSize,
  Stack,
  Text,
} from '@mantine/core';
import { User } from '@prisma/client';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { getInitials } from '~/utils/string-helpers';

const mapAvatarTextSize: Record<MantineSize, { textSize: MantineSize; subTextSize: MantineSize }> =
  {
    xs: { textSize: 'xs', subTextSize: 'xs' },
    sm: { textSize: 'sm', subTextSize: 'xs' },
    md: { textSize: 'sm', subTextSize: 'xs' },
    lg: { textSize: 'md', subTextSize: 'sm' },
    xl: { textSize: 'md', subTextSize: 'sm' },
  };

export function UserAvatar({
  user,
  withUsername,
  subText: subText,
  avatarProps,
  badge,
  size = 'sm',
  spacing = 4,
}: Props) {
  const { textSize, subTextSize } = mapAvatarTextSize[size];

  return (
    <Group align="center" spacing={spacing} noWrap>
      <Avatar
        src={user?.image ? getEdgeUrl(user.image, { width: 96 }) : undefined}
        alt={`${user?.username}'s Avatar` ?? 'User avatar'}
        radius="xl"
        size={size}
        {...avatarProps}
      >
        {user?.username ? getInitials(user?.username) : null}
      </Avatar>
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && (
            <Group spacing={4}>
              <Text size={textSize} lineClamp={1}>
                {user?.username ?? user?.name}
              </Text>
              {badge}
            </Group>
          )}
          {subText && typeof subText === 'string' ? (
            <Text size={subTextSize} color="dimmed">
              {subText}
            </Text>
          ) : (
            subText
          )}
        </Stack>
      ) : null}
    </Group>
  );
}

type Props = {
  user?: Partial<User> | null;
  withUsername?: boolean;
  withLink?: boolean;
  avatarProps?: AvatarProps;
  subText?: React.ReactNode;
  size?: MantineSize;
  spacing?: MantineNumberSize;
  badge?: React.ReactElement<BadgeProps> | null;
};
