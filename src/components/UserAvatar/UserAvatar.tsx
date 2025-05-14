import {
  Avatar,
  AvatarProps,
  BadgeProps,
  Group,
  Indicator,
  IndicatorProps,
  Loader,
  MantineSize,
  MantineTheme,
  Paper,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconUser } from '@tabler/icons-react';
import { useGetEdgeUrl } from '~/client-utils/cf-images-utils';
import { Username } from '~/components/User/Username';
import { UserAvatarProfilePicture } from '~/components/UserAvatar/UserAvatarProfilePicture';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { getInitials } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { EdgeMedia } from '../EdgeMedia/EdgeMedia';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { hasPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

const mapAvatarTextSize: Record<MantineSize, { textSize: MantineSize; subTextSize: MantineSize }> =
  {
    xs: { textSize: 'xs', subTextSize: 'xs' },
    sm: { textSize: 'sm', subTextSize: 'xs' },
    md: { textSize: 'sm', subTextSize: 'xs' },
    lg: { textSize: 'md', subTextSize: 'sm' },
    xl: { textSize: 'lg', subTextSize: 'sm' },
  };

/**
 * Gets explicit avatar size in pixels
 */
const getRawAvatarSize = (size: MantineSpacing) => {
  if (typeof size === 'number') return size;

  // Based off Mantine avatar sizes
  switch (size) {
    case 'xs':
      return 16;
    case 'sm':
      return 26;
    case 'md':
      return 38;
    case 'lg':
      return 56;
    case 'xl':
      return 84;
    default:
      return 96;
  }
};

/**
 * Gets explicit avatar size in pixels
 */
const getRawAvatarRadius = (radius: MantineSpacing, theme: MantineTheme) => {
  if (typeof radius === 'number') return radius;
  if (radius === 'xl') return '50%';

  return theme.radius[radius];
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
  badgeSize,
  withDecorations = true,
  withOverlay = false,
  className,
}: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme();
  const { canViewNsfw } = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();

  const { data: fallbackUser, isInitialLoading } = trpc.user.getById.useQuery(
    { id: userId as number },
    { enabled: !user && !!userId && userId > -1, cacheTime: Infinity, staleTime: Infinity }
  );

  const avatarUser = user ?? { ...fallbackUser, cosmetics: [] };
  const imageUrl = useGetEdgeUrl(avatarUser?.image, {
    width: typeof avatarSize === 'number' ? avatarSize : 96,
  });

  // If using a userId, show loading
  if (isInitialLoading)
    return (
      <Group>
        <Loader size="sm" />
        <Text size="sm">Loading user...</Text>
      </Group>
    );
  // If no user or user is civitai, return null
  if (!avatarUser || avatarUser.id === -1) return null;
  const userDeleted = !!avatarUser.deletedAt;

  textSize ??= mapAvatarTextSize[size].textSize;
  subTextSize ??= mapAvatarTextSize[size].subTextSize;

  const imageSize = getRawAvatarSize(
    (avatarProps?.size ?? avatarSize ?? size) as MantineSpacing
  );
  const imageRadius = getRawAvatarRadius(
    (avatarProps?.radius ?? radius) as MantineSpacing,
    theme
  );
  const nsfwLevel = avatarUser.profilePicture?.nsfwLevel ?? 0;
  const blockedProfilePicture =
    avatarUser.profilePicture?.ingestion === 'Blocked' ||
    (!canViewNsfw ? !hasPublicBrowsingLevel(nsfwLevel) : nsfwLevel > browsingLevel);
  const avatarBgColor = colorScheme === 'dark' ? 'rgba(255,255,255,0.31)' : 'rgba(0,0,0,0.31)';

  const image = avatarUser.profilePicture;
  const decoration =
    withDecorations && avatarUser && !avatarUser.deletedAt
      ? (avatarUser.cosmetics?.find((c) => c.cosmetic?.type === 'ProfileDecoration')
          ?.cosmetic as Omit<ContentDecorationCosmetic, 'description' | 'obtainedAt' | 'name'>)
      : undefined;

  return (
    <Group
      className={className}
      align="center"
      style={
        withOverlay
          ? {
              padding: '0 10px 0 0',
              backgroundColor: 'rgba(0, 0, 0, 0.31)',
              borderRadius: '1000px',
            }
          : undefined
      }
      gap={spacing}
      wrap="nowrap"
    >
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
            {decoration && decoration.data.url && (
              <EdgeMedia
                src={decoration.data.url}
                type="image"
                name="user avatar decoration"
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  maxWidth: 'none',
                  transform: 'translate(-50%,-50%)',
                  width: decoration.data.offset ? `calc(100% + ${decoration.data.offset})` : '100%',
                  height: decoration.data.offset
                    ? `calc(100% + ${decoration.data.offset})`
                    : '100%',
                  zIndex: 1,
                }}
              />
            )}
            {avatarUser.profilePicture?.id && !blockedProfilePicture && !userDeleted ? (
              <Paper
                w={imageSize}
                h={imageSize}
                style={{
                  overflow: 'hidden',
                  position: 'relative',
                  backgroundColor: avatarBgColor,
                  borderRadius: imageRadius,
                }}
              >
                {!image || !avatarUser.id ? (
                  <Text size={textSize}>
                    {avatarUser.username ? (
                      getInitials(avatarUser.username)
                    ) : (
                      <IconUser size={imageSize} />
                    )}
                  </Text>
                ) : (
                  <UserAvatarProfilePicture
                    id={avatarUser.id}
                    username={avatarUser.username}
                    image={image}
                  />
                )}
              </Paper>
            ) : (
              <Avatar
                src={
                  avatarUser.image && !blockedProfilePicture && !userDeleted ? imageUrl : undefined
                }
                alt={
                  avatarUser.username && !userDeleted
                    ? `${avatarUser.username}'s Avatar`
                    : undefined
                }
                radius={radius || 'xl'}
                size={avatarSize ?? size}
                imageProps={{ loading: 'lazy' }}
                sx={{ backgroundColor: avatarBgColor }}
                {...avatarProps}
              >
                {avatarUser.username && !userDeleted ? getInitials(avatarUser.username) : null}
              </Avatar>
            )}
          </Indicator>
        </UserProfileLink>
      )}
      {withUsername || subText ? (
        <Stack gap={0} align="flex-start">
          {withUsername && (
            <UserProfileLink user={avatarUser} linkToProfile={linkToProfile}>
              <Group gap={4} align="center">
                <Username
                  username={avatarUser.username}
                  deletedAt={avatarUser.deletedAt}
                  cosmetics={(avatarUser as Partial<UserWithCosmetics>).cosmetics ?? []}
                  size={textSize}
                  badgeSize={badgeSize}
                />
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
}

type Props = {
  user?: Partial<UserWithCosmetics> | null;
  withUsername?: boolean;
  withLink?: boolean;
  avatarProps?: AvatarProps;
  subText?: React.ReactNode;
  subTextForce?: boolean;
  size?: MantineSize;
  spacing?: MantineSpacing;
  badge?: React.ReactElement<BadgeProps> | null;
  linkToProfile?: boolean;
  textSize?: MantineSize;
  subTextSize?: MantineSize;
  includeAvatar?: boolean;
  radius?: MantineSpacing;
  avatarSize?: MantineSpacing;
  userId?: number;
  indicatorProps?: Omit<IndicatorProps, 'children'>;
  badgeSize?: number;
  withDecorations?: boolean;
  withOverlay?: boolean;
  className?: string;
};

export const UserProfileLink = ({
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
    <Link href={href} onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}>
      {children}
    </Link>
  );
};
