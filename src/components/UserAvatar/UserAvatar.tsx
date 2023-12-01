import {
  Avatar,
  AvatarProps,
  BadgeProps,
  Group,
  Indicator,
  IndicatorProps,
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
import { trpc } from '~/utils/trpc';

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
  radius = 'xl',
  avatarSize,
  userId,
  indicatorProps,
}: Props) {
  const currentUser = useCurrentUser();

  const { data: fallbackUser } = trpc.user.getById.useQuery(
    { id: userId as number },
    { enabled: !user && !!userId && userId > -1, cacheTime: Infinity, staleTime: Infinity }
  );

  const avatarUser = user ?? fallbackUser;

  // If no user or user is civitai, return null
  if (!avatarUser || avatarUser.id === -1) return null;
  const userDeleted = !!avatarUser.deletedAt;

  textSize ??= mapAvatarTextSize[size].textSize;
  subTextSize ??= mapAvatarTextSize[size].subTextSize;

  const avatar = (
    <Group align="center" spacing={spacing} noWrap>
      {includeAvatar && (
        <UserProfileLink user={avatarUser} linkToProfile={linkToProfile}>
          <Indicator
            {...indicatorProps}
            position="bottom-end"
            offset={7}
            size={16}
            disabled={!indicatorProps}
            withBorder
          >
            <Avatar
              src={
                avatarUser.image && !userDeleted
                  ? getEdgeUrl(avatarUser.image, {
                      width: typeof avatarSize === 'number' ? avatarSize : 96,
                      anim: currentUser
                        ? !currentUser.autoplayGifs
                          ? false
                          : undefined
                        : undefined,
                    })
                  : undefined
              }
              alt={
                avatarUser.username && !userDeleted ? `${avatarUser.username}'s Avatar` : undefined
              }
              radius={radius || 'xl'}
              size={avatarSize ?? size}
              imageProps={{ loading: 'lazy' }}
              sx={{ backgroundColor: 'rgba(0,0,0,0.31)' }}
              {...avatarProps}
            >
              {avatarUser.username && !userDeleted ? getInitials(avatarUser.username) : null}
            </Avatar>
          </Indicator>
        </UserProfileLink>
      )}
      {withUsername || subText ? (
        <Stack spacing={0}>
          {withUsername && (
            <UserProfileLink user={avatarUser} linkToProfile={linkToProfile}>
              <Group spacing={4} align="center">
                <Username {...avatarUser} size={textSize} />
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
  radius?: MantineSize;
  avatarSize?: MantineSize | number;
  userId?: number;
  indicatorProps?: Omit<IndicatorProps, 'children'>;
};
