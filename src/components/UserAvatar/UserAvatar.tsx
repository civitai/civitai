import {
  Anchor,
  Avatar,
  AvatarProps,
  BadgeProps,
  createStyles,
  Group,
  MantineNumberSize,
  MantineSize,
  Stack,
  Text,
} from '@mantine/core';
import { User } from '@prisma/client';
import Link from 'next/link';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { Username } from '~/components/User/Username';
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
  subText,
  subTextForce = false,
  avatarProps,
  badge,
  size = 'sm',
  spacing = 8,
  linkToProfile = false,
  textSize,
  subTextSize,
}: Props) {
  const { classes } = useStyles();

  if (!user) return null;

  textSize ??= mapAvatarTextSize[size].textSize;
  subTextSize ??= mapAvatarTextSize[size].subTextSize;
  const avatar = (
    <Group align="center" spacing={spacing} noWrap>
      <Avatar
        src={user.image ? getEdgeUrl(user.image, { width: 96 }) : undefined}
        alt={user.username ? `${user.username}'s Avatar` : undefined}
        radius="xl"
        size={size}
        {...avatarProps}
      >
        {user.username ? getInitials(user.username) : null}
      </Avatar>
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && (
            <Group spacing={4}>
              <Username username={user.username} deletedAt={user.deletedAt} size={textSize} />
              {badge}
            </Group>
          )}
          {subText && (typeof subText === 'string' || subTextForce) ? (
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

  return linkToProfile && !user.deletedAt ? (
    <Link href={`/user/${user.username}`} passHref>
      <Anchor
        variant="text"
        className={classes.link}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
      >
        {avatar}
      </Anchor>
    </Link>
  ) : (
    avatar
  );
}

type Props = {
  user?: Pick<Partial<User>, 'username' | 'image' | 'deletedAt'> | null;
  withUsername?: boolean;
  withLink?: boolean;
  avatarProps?: AvatarProps;
  subText?: React.ReactNode;
  subTextForce?: boolean;
  size?: MantineSize;
  spacing?: MantineNumberSize;
  badge?: React.ReactElement<BadgeProps> | null;
  linkToProfile?: boolean;
  textSize?: MantineSize;
  subTextSize?: MantineSize;
};

const useStyles = createStyles(() => ({
  link: {
    '&:hover': {
      textDecoration: 'underline',
    },
  },
}));
