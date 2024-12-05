import { createStyles, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconUser } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatarProfilePicture } from '~/components/UserAvatar/UserAvatarProfilePicture';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  NamePlateCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { ProfileImage } from '~/server/selectors/image.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { hasPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { getInitials } from '~/utils/string-helpers';

export function UserAvatarSimple({
  id,
  profilePicture,
  username,
  deletedAt,
  cosmetics,
}: {
  id: number;
  profilePicture?: ProfileImage | null;
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
}) {
  const { canViewNsfw } = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const { classes } = useStyles();
  const displayProfilePicture =
    !deletedAt && profilePicture && profilePicture.ingestion !== 'Blocked';
  const router = useRouter();

  const nameplate = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'NamePlate' : undefined
  )?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'Badge' : undefined
  )?.cosmetic as Omit<BadgeCosmetic, 'description' | 'obtainedAt'>;
  const decoration = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'ProfileDecoration' : undefined
  )?.cosmetic as Omit<ContentDecorationCosmetic, 'description' | 'obtainedAt'>;
  const additionalTextProps = nameplate?.data;

  return (
    <UnstyledButton
      onClick={() => router.push(username ? `/user/${username}` : `/user?id=${id}`)}
      className="flex items-center gap-2"
    >
      {displayProfilePicture && (
        <div className="relative ">
          <div className="flex size-8 items-center justify-center overflow-hidden rounded-full bg-white/30 dark:bg-black/30">
            {profilePicture &&
            (!canViewNsfw
              ? hasPublicBrowsingLevel(profilePicture.nsfwLevel)
              : Flags.hasFlag(browsingLevel, profilePicture.nsfwLevel)) ? (
              <UserAvatarProfilePicture id={id} username={username} image={profilePicture} />
            ) : (
              <span className="text-sm font-semibold text-dark-8 dark:text-gray-0">
                {username ? getInitials(username) : <IconUser size={32} />}
              </span>
            )}
          </div>

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
                height: decoration.data.offset ? `calc(100% + ${decoration.data.offset})` : '100%',
                zIndex: 2,
              }}
            />
          )}
        </div>
      )}
      {deletedAt ? (
        <Text size="sm">[deleted]</Text>
      ) : (
        <>
          <Text
            size="sm"
            weight={500}
            lineClamp={1}
            color="white"
            className={classes.username}
            {...additionalTextProps}
          >
            {username}
          </Text>
          {badge?.data.url && (
            <Tooltip color="dark" label={badge.name} withArrow withinPortal>
              {badge.data.animated ? (
                <div style={{ display: 'flex', width: 28 }}>
                  <EdgeMedia src={badge.data.url} alt={badge.name} />
                </div>
              ) : (
                <div style={{ display: 'flex' }}>
                  <EdgeMedia src={badge.data.url} alt={badge.name} width={28} />
                </div>
              )}
            </Tooltip>
          )}
        </>
      )}
    </UnstyledButton>
  );
}

const useStyles = createStyles((theme) => ({
  username: {
    verticalAlign: 'middle',
    filter:
      theme.colorScheme === 'dark'
        ? 'drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.8))'
        : 'drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.2))',
  },
}));
