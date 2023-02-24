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
import Link from 'next/link';

import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { getInitials } from '~/utils/string-helpers';

const mapAvatarTextSize: Record<MantineSize, { textSize: MantineSize; subTextSize: MantineSize }> =
  {
    xs: { textSize: 'xs', subTextSize: 'xs' },
    sm: { textSize: 'sm', subTextSize: 'xs' },
    md: { textSize: 'sm', subTextSize: 'xs' },
    lg: { textSize: 'md', subTextSize: 'sm' },
    xl: { textSize: 'lg', subTextSize: 'sm' },
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
  includeAvatar = true,
}: Props) {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();

  if (!user) return null;
  const userDeleted = !!user.deletedAt;

  textSize ??= mapAvatarTextSize[size].textSize;
  subTextSize ??= mapAvatarTextSize[size].subTextSize;
  const avatar = (
    <Group align="center" spacing={spacing} noWrap>
      {includeAvatar && (
        <Avatar
          src={
            user.image && !userDeleted
              ? getEdgeUrl(user.image, {
                  width: 96,
                  anim: currentUser ? (!currentUser.autoplayGifs ? false : undefined) : undefined,
                })
              : undefined
          }
          alt={user.username && !userDeleted ? `${user.username}'s Avatar` : undefined}
          radius="xl"
          size={size}
          {...avatarProps}
        >
          {user.username && !userDeleted ? getInitials(user.username) : null}
        </Avatar>
      )}
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && (
            <Group spacing={4} align="center">
              <Username {...user} size={textSize} />
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

  return linkToProfile && !userDeleted ? (
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
  user?: Partial<UserWithCosmetics> | null;
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
  includeAvatar?: boolean;
};

const useStyles = createStyles(() => ({
  link: {
    '&:hover': {
      // textDecoration: 'underline',
    },
  },
}));
