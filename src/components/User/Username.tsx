import { Badge, BadgeProps, Group, MantineSize, Text, TextProps } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getRandom } from '~/utils/array-helpers';
import { useEffect, useState } from 'react';

// TODO justin: remove once final support badge is implemented
const levels: SupportLevel[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const textBadgeProps: Record<SupportLevel, { textProps: TextProps; badgeProps: BadgeProps }> = {
  common: { textProps: {}, badgeProps: {} },
  uncommon: {
    textProps: { variant: 'gradient', gradient: { from: '#1eff00', to: '#00ffc4', deg: 180 } },
    badgeProps: { color: 'green' },
  },
  rare: {
    textProps: { variant: 'gradient', gradient: { from: '#0070dd', to: '#3700dd', deg: 180 } },
    badgeProps: { color: 'blue' },
  },
  epic: {
    textProps: { variant: 'gradient', gradient: { from: '#ee35dc', to: '#a335ee', deg: 180 } },
    badgeProps: { color: 'violet' },
  },
  legendary: {
    textProps: { variant: 'gradient', gradient: { from: '#ffbf00', to: '#ff8000', deg: 180 } },
    badgeProps: { color: 'orange' },
  },
};

export function Username({
  username,
  deletedAt,
  supportLevel: initialSupportLevel,
  size = 'sm',
  inherit = false,
}: Props) {
  const features = useFeatureFlags();

  // TODO justin: remove random once final support badge is implemented
  // Briant made a change to `supportLevel` to fix ssr mismatches
  const [supportLevel, setSupportLevel] = useState<SupportLevel>('common');
  useEffect(() => {
    setSupportLevel(features.memberBadges ? getRandom(levels) : 'common');
  }, []); // eslint-disable-line

  if (deletedAt) return <Text size={size}>[deleted]</Text>;

  const { textProps, badgeProps } = textBadgeProps[supportLevel];

  return (
    <Group spacing={4} noWrap>
      <Text
        {...textProps}
        size={size}
        weight={500}
        lineClamp={1}
        sx={{ lineHeight: 1.1 }}
        inherit={inherit}
      >
        {username}
      </Text>
      {supportLevel !== 'common' ? (
        // TODO justin: replace with icon once final support badge is implemented
        <Badge {...badgeProps} radius="xl">
          {supportLevel}
        </Badge>
      ) : null}
    </Group>
  );
}

type SupportLevel = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
type Props = {
  username?: string | null;
  deletedAt?: Date | null;
  supportLevel?: SupportLevel;
  size?: MantineSize;
  inherit?: boolean;
};
