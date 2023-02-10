import { Group, MantineSize, Text, Tooltip } from '@mantine/core';
import React from 'react';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

const mapSizeToImageWidth: Record<MantineSize, number> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 32,
  xl: 36,
};

export function Username({
  username,
  deletedAt,
  cosmetics = [],
  size = 'sm',
  inherit = false,
}: Props) {
  const features = useFeatureFlags();
  if (deletedAt) return <Text size={size}>[deleted]</Text>;

  const nameplate = cosmetics.find(({ cosmetic }) => cosmetic.type === 'NamePlate')
    ?.cosmetic as Omit<NamePlateCosmetic, 'name' | 'description' | 'obtainedAt'>;
  const badge = cosmetics.find(({ cosmetic }) => cosmetic.type === 'Badge')?.cosmetic as Omit<
    BadgeCosmetic,
    'description' | 'obtainedAt'
  >;
  const additionalTextProps = features.memberBadges ? nameplate?.data : {};
  const badgeSize = mapSizeToImageWidth[size];

  return (
    <Group spacing={4} noWrap>
      <Text
        {...additionalTextProps}
        size={size}
        weight={500}
        lineClamp={1}
        sx={{ lineHeight: 1.1 }}
        inherit={inherit}
      >
        {username}
      </Text>
      {features.memberBadges && badge?.data.url && (
        <Tooltip label={badge.name} withArrow>
          <div>
            <EdgeImage src={badge.data.url} width={badgeSize} />
          </div>
        </Tooltip>
      )}
    </Group>
  );
}

type Props = {
  username?: string | null;
  deletedAt?: Date | null;
  cosmetics?: UserWithCosmetics['cosmetics'];
  size?: MantineSize;
  inherit?: boolean;
};
