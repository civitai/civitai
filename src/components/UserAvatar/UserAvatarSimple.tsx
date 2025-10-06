import { Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconUser } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatarProfilePicture } from '~/components/UserAvatar/UserAvatarProfilePicture';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  NamePlateCosmetic,
} from '~/server/selectors/cosmetic.selector';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { hasPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { getInitials } from '~/utils/string-helpers';
import classes from './UserAvatarSimple.module.scss';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

export function UserAvatarSimple({
  id,
  profilePicture,
  username,
  deletedAt,
  cosmetics,
  autoplayAnimations,
}: {
  id: number;
  profilePicture?: ProfileImage | null;
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
  autoplayAnimations?: boolean;
}) {
  const { canViewNsfw } = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const displayProfilePicture =
    !deletedAt && profilePicture && profilePicture.ingestion !== 'Blocked';
  const router = useRouter();
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);

  if (id === -1) return null;

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

  const anim = !autoplayGifs || autoplayAnimations === false ? false : undefined;

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
              anim={anim}
              // original={anim === false ? false : undefined}
              type="image"
              name="user avatar decoration"
              className="absolute left-1/2 top-1/2 z-[2]"
              loading="lazy"
              style={{
                maxWidth: 'none',
                width: decoration.data.offset ? `calc(100% + ${decoration.data.offset})` : '100%',
                height: decoration.data.offset ? `calc(100% + ${decoration.data.offset})` : '100%',
                transform: 'translate(-50%, -50%)',
              }}
              optimized
              width={96}
              original={false}
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
            fw={500}
            lineClamp={1}
            color="white"
            className={classes.username}
            {...additionalTextProps}
          >
            {username}
          </Text>
          {badge?.data.url && (
            <Tooltip color="dark" label={badge.name} withArrow withinPortal>
              <div style={{ display: 'flex', width: 28 }}>
                <EdgeMedia
                  src={badge.data.url}
                  anim={badge.data.animated && anim}
                  original={false}
                  alt={badge.name}
                  optimized
                  loading="lazy"
                  width={96}
                />
              </div>
            </Tooltip>
          )}
        </>
      )}
    </UnstyledButton>
  );
}
