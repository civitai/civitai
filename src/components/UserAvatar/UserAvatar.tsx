import { Avatar, AvatarProps, Group, Text } from '@mantine/core';
import { User } from '@prisma/client';
import { getInitials } from '~/utils/string-helpers';

export function UserAvatar({ user, withUsername, avatarProps }: Props) {
  return (
    <Group align="center" spacing={4}>
      <Avatar
        src={user.image}
        alt={user.name ?? 'User avatar'}
        radius="xl"
        size={20}
        {...avatarProps}
      >
        {getInitials(user.name ?? '')}
      </Avatar>
      {withUsername ? <Text>{user.username}</Text> : null}
    </Group>
  );
}

type Props = {
  user: User;
  withUsername?: boolean;
  avatarProps?: AvatarProps;
};
