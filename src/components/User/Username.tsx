import { Group, MantineSize, Text, Tooltip } from '@mantine/core';
import React from 'react';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

const mapSizeToImageWidth: Record<MantineSize, number> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 28,
  xl: 32,
};

export function Username({
  username,
  deletedAt,
  cosmetics = [],
  size = 'sm',
  inherit = false,
  badgeSize,
}: Props) {
  if (deletedAt) return <Text size={size}>[deleted]</Text>;

  const nameplate = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'NamePlate' : undefined
  )?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'Badge' : undefined
  )?.cosmetic as Omit<BadgeCosmetic, 'description' | 'obtainedAt'>;
  const additionalTextProps = nameplate?.data;
  badgeSize ??= mapSizeToImageWidth[size];

  return (
    <Group spacing={8} noWrap align="center">
      <Text
        size={size}
        weight={500}
        lineClamp={1}
        sx={{ verticalAlign: 'middle' }}
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

  const filter = 'drop-shadow(3px 3px 1px rgba(0, 0, 0, 0.8))';

  return (
    <Tooltip color="dark" label={badge.name} withArrow withinPortal>
      {badge.data.animated ? (
        <div
          style={{
            display: 'flex',
            width: badgeSize,
            zIndex,
            filter,
          }}
        >
          <EdgeMedia src={badge.data.url} alt={badge.name} width="original" />
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
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
  size?: MantineSize;
  inherit?: boolean;
  badgeSize?: number;
};
