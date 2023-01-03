import {
  Anchor,
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
import Link from 'next/link';

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
  spacing = 8,
  linkToProfile = false,
}: Props) {
  const { textSize, subTextSize } = mapAvatarTextSize[size];
  const avatar = (
    <Group align="center" spacing={spacing} noWrap>
      <Avatar
        src={user?.image ? getEdgeUrl(user.image, { width: 96 }) : undefined}
        alt={user?.username ? `${user.username}'s Avatar` : undefined}
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
              <Text size={textSize} lineClamp={1} weight={500} sx={{ lineHeight: 1.1 }}>
                {user?.username}
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

  return linkToProfile ? (
    <Link href={`/user/${user?.username}`} passHref>
      <Anchor variant="text">{avatar}</Anchor>
    </Link>
  ) : (
    avatar
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
  linkToProfile?: boolean;
};
