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
import { NextLink } from '@mantine/next';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
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
  const currentUser = useCurrentUser();

  if (!user) return null;
  const userDeleted = !!user.deletedAt;

  textSize ??= mapAvatarTextSize[size].textSize;
  subTextSize ??= mapAvatarTextSize[size].subTextSize;
  const avatar = (
    <Group align="center" spacing={spacing} noWrap>
      {includeAvatar && (
        <UserProfileLink user={user} linkToProfile={linkToProfile}>
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
            imageProps={{ loading: 'lazy' }}
            {...avatarProps}
          >
            {user.username && !userDeleted ? getInitials(user.username) : null}
          </Avatar>
        </UserProfileLink>
      )}
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && (
            <UserProfileLink user={user} linkToProfile={linkToProfile}>
              <Group spacing={4} align="center">
                <Username {...user} size={textSize} />
                {badge}
              </Group>
            </UserProfileLink>
          )}
          {subText && (typeof subText === 'string' || subTextForce) ? (
            <Text size={subTextSize} color="dimmed" my={-2} lineClamp={1}>
              {subText}
            </Text>
          ) : (
            subText
          )}
        </Stack>
      ) : null}
    </Group>
  );

  return avatar;
}

const UserProfileLink = ({
  children,
  user,
  linkToProfile,
}: {
  children: React.ReactNode;
  user?: Partial<UserWithCosmetics> | null;
  linkToProfile?: boolean;
}) => {
  if (!user || !linkToProfile || !!user.deletedAt) return <>{children}</>;

  let href = `/user/${user.username}`;
  if (!user.username) href += `?id=${user.id}`;

  return (
    <NextLink href={href} onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}>
      {children}
    </NextLink>
  );

  // return (
  //   <Link href={href} passHref>
  //     <Anchor
  //       variant="text"
  //       onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
  //     ></Anchor>
  //   </Link>
  // );
};

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
