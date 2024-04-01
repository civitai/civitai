import { createStyles, Text, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconUser } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatarProfilePicture } from '~/components/UserAvatar/UserAvatarProfilePicture';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { ProfileImage } from '~/server/selectors/image.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { getInitials } from '~/utils/string-helpers';

export function UserAvatarSimple({
  id,
  profilePicture,
  username,
  deletedAt,
  cosmetics,
}: {
  id: number;
  profilePicture?: ProfileImage;
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
}) {
  const { classes } = useStyles();
  const displayProfilePicture =
    !deletedAt && profilePicture && profilePicture.ingestion !== 'Blocked';

  const nameplate = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'NamePlate' : undefined
  )?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'Badge' : undefined
  )?.cosmetic as Omit<BadgeCosmetic, 'description' | 'obtainedAt'>;
  const additionalTextProps = nameplate?.data;

  return (
    <NextLink
      href={username ? `/user/${username}` : `/user?id=${id}`}
      className="flex gap-2 items-center"
    >
      {displayProfilePicture && (
        <div className={classes.profilePictureWrapper}>
          {!profilePicture ? (
            <Text size="sm">{username ? getInitials(username) : <IconUser size={32} />}</Text>
          ) : (
            <UserAvatarProfilePicture id={id} username={username} image={profilePicture} />
          )}
        </div>
      )}
      {deletedAt ? (
        <Text size="sm">[deleted]</Text>
      ) : (
        <>
          <Text size="sm" weight={500} lineClamp={1} {...additionalTextProps}>
            {username}
          </Text>
          {badge?.data.url && (
            <Tooltip color="dark" label={badge.name} withArrow withinPortal>
              {badge.data.animated ? (
                <div style={{ display: 'flex', width: 28 }}>
                  <EdgeMedia src={badge.data.url} alt={badge.name} width="original" />
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
    </NextLink>
  );
}

const useStyles = createStyles((theme) => ({
  profilePictureWrapper: {
    overflow: 'hidden',
    backgroundColor: theme.colorScheme === 'dark' ? 'rgba(255,255,255,0.31)' : 'rgba(0,0,0,0.31)',
    borderRadius: theme.radius.md,
    height: 32,
    width: 32,
  },
}));
