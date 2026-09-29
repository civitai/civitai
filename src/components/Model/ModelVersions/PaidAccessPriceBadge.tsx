import { Badge, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * The price chip pinned to the corner of a paid-access Download / Create button.
 *
 * Its colour says WHICH Buzz the sale takes: the domain's own (Yellow on .com, Green on .green),
 * split with Blue when the creator's terms accept Blue. It used to be a flat yellow everywhere, which
 * told buyers holding only Blue Buzz they couldn't pay — and told .green buyers the wrong colour.
 */
export function PaidAccessPriceBadge({
  price,
  acceptsBlueBuzz,
  listedOnly,
  decimals,
}: {
  price: number;
  acceptsBlueBuzz?: boolean;
  /** The viewer already has access; the chip is informational (owner/mod seeing the buyer price). */
  listedOnly?: boolean;
  decimals?: number;
}) {
  const theme = useMantineTheme();
  const features = useFeatureFlags();
  const domainColor = features.isGreen ? 'green.7' : 'yellow.7';
  const domainLabel = features.isGreen ? 'Green' : 'Yellow';
  const amount = abbreviateNumber(price, decimals != null ? { decimals } : undefined);

  const currencyLabel = acceptsBlueBuzz ? `Blue or ${domainLabel} Buzz` : `${domainLabel} Buzz`;
  const tooltip = listedOnly
    ? `Buyers pay ${amount} ${currencyLabel}`
    : `${amount} ${currencyLabel}`;

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        radius="sm"
        size="sm"
        variant={acceptsBlueBuzz ? 'gradient' : 'filled'}
        gradient={{ from: 'blue.5', to: domainColor, deg: 135 }}
        color={domainColor}
        style={{
          position: 'absolute',
          top: '-8px',
          right: '-8px',
          boxShadow: theme.shadows.sm,
          padding: '4px 2px',
          paddingRight: '6px',
        }}
      >
        <Group gap={0} wrap="nowrap">
          <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={14} />{' '}
          <Text size="xs" fz={11} c="dark.9">
            {amount}
          </Text>
        </Group>
      </Badge>
    </Tooltip>
  );
}
