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
}: Props) {
  if (deletedAt) return <Text size={size}>[deleted]</Text>;

  const nameplate = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'NamePlate' : undefined
  )?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics?.find(({ cosmetic }) =>
    cosmetic ? cosmetic.type === 'Badge' : undefined
  )?.cosmetic as Omit<BadgeCosmetic, 'description' | 'obtainedAt'>;
  const additionalTextProps = nameplate?.data;
  const badgeSize = mapSizeToImageWidth[size];

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
      {badge?.data.url && (
        <Tooltip color="dark" label={badge.name} withArrow>
          <div style={{ display: 'flex' }}>
            <EdgeMedia src={badge.data.url} width={badgeSize} />
          </div>
        </Tooltip>
      )}
    </Group>
  );
}

type Props = {
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
  size?: MantineSize;
  inherit?: boolean;
};
