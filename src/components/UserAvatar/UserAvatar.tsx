import { Avatar, AvatarProps, Group, Stack, Text } from '@mantine/core';
import { User } from '@prisma/client';
import { getInitials } from '~/utils/string-helpers';

export function UserAvatar({ user, withUsername, subText, avatarProps }: Props) {
  return (
    <Group align="center" spacing={4}>
      <Avatar
        src={user?.image}
        alt={user?.name ?? 'User avatar'}
        radius="xl"
        size={20}
        {...avatarProps}
      >
        {user?.name ? getInitials(user?.name) : null}
      </Avatar>
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && <Text size="sm">{user?.username ?? user?.name}</Text>}
          {subText && (
            <Text size="xs" color="dimmed">
              {subText}
            </Text>
          )}
        </Stack>
      ) : null}
    </Group>
  );
}

type Props = {
  user?: Partial<User>;
  withUsername?: boolean;
  withLink?: boolean;
  avatarProps?: AvatarProps;
  subText?: string;
};
