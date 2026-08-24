import type { MantineSize } from '@mantine/core';
import { Group, Text, Tooltip } from '@mantine/core';
import React from 'react';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

const mapSizeToImageWidth: Record<MantineSize, number> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 28,
  xl: 32,
};

export function Username({
  id,
  username,
  deletedAt,
  cosmetics = [],
  size = 'sm',
  inherit = false,
  badgeSize,
}: Props) {
  // A moderator following a report to a deleted account had nothing to go on — every surface said
  // "[deleted]" and the id was only in the URL, if it was anywhere. Moderators see the id; everyone
  // else still sees the name being gone, which is what the deletion means to them.
  const currentUser = useCurrentUser();
  if (deletedAt || !username)
    return (
      <Text size={size}>{currentUser?.isModerator && id ? `[deleted] #${id}` : '[deleted]'}</Text>
    );

  const nameplate = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'NamePlate' : undefined
  )?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'Badge' : undefined
  )?.cosmetic as Omit<BadgeCosmetic, 'description' | 'obtainedAt'>;
  const additionalTextProps = nameplate?.data;
  badgeSize ??= mapSizeToImageWidth[size];

  return (
    <Group gap={8} wrap="nowrap" align="center">
      <Text
        size={size}
        fw={500}
        lineClamp={1}
        td="none"
        className="align-middle drop-shadow-[1px_1px_1px_rgba(0,0,0,0.8)] dark:drop-shadow-[1px_1px_1px_rgba(0,0,0,0.2)]"
        inherit={inherit}
        {...additionalTextProps}
      >
        {username}
      </Text>
      <BadgeDisplay badge={badge as BadgeCosmetic} badgeSize={badgeSize} />
    </Group>
  );
}

export const BadgeDisplay = ({
  badge,
  badgeSize,
  zIndex,
}: {
  badge?: BadgeCosmetic;
  badgeSize?: number;
  zIndex?: number;
}) => {
  if (!badge?.data.url || badgeSize === 0) return null;

  const shadowDistance = Math.max(1, Math.round((badgeSize ?? 24) / 24));
  const filter = `drop-shadow(${shadowDistance}px ${shadowDistance}px 1px rgba(0, 0, 0, 0.8))`;

  return (
    <Tooltip
      label={
        <div style={{ textAlign: 'center', padding: 4 }}>
          <div>{badge.name}</div>
          <div style={{ fontSize: 'small', color: 'gray' }}>{badge.description}</div>
        </div>
      }
      maw={300}
      multiline
      withArrow
      withinPortal
    >
      {badge.data.animated ? (
        <div
          style={{
            display: 'flex',
            width: badgeSize,
            zIndex,
            filter,
          }}
        >
          <EdgeMedia src={badge.data.url} alt={badge.name} width={badgeSize} />
        </div>
      ) : (
        <div style={{ display: 'flex', zIndex, filter }}>
          <EdgeMedia src={badge.data.url} alt={badge.name} width={badgeSize} />
        </div>
      )}
    </Tooltip>
  );
};

type Props = {
  /** Only read when the name is gone and the viewer is a moderator — see the `[deleted]` branch. Most
   *  call sites spread a user object, so it arrives without anyone passing it deliberately. */
  id?: number | null;
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
  size?: MantineSize;
  inherit?: boolean;
  badgeSize?: number;
};
