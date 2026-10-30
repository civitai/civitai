import { Badge, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * The background for anything that advertises a paid-access price: the domain's own Buzz colour
 * (Yellow on .com, Green on .green), cut hard on the diagonal with Blue when the terms accept Blue.
 * A hard cut rather than a gradient so it reads as "two currencies", not as one new colour.
 */
export function paidAccessBuzzBackground({
  isGreen,
  acceptsBlueBuzz,
}: {
  isGreen: boolean;
  acceptsBlueBuzz?: boolean;
}) {
  const domain = isGreen ? 'var(--mantine-color-green-7)' : 'var(--mantine-color-yellow-7)';
  if (!acceptsBlueBuzz) return domain;
  const blue = 'var(--mantine-color-blue-6)';
  return `linear-gradient(135deg, ${blue} 0%, ${blue} 50%, ${domain} 50%, ${domain} 100%)`;
}

/** "Yellow Buzz", "Blue or Green Buzz" — what a paid-access price is payable in. */
export function paidAccessBuzzLabel({
  isGreen,
  acceptsBlueBuzz,
}: {
  isGreen: boolean;
  acceptsBlueBuzz?: boolean;
}) {
  const domain = isGreen ? 'Green' : 'Yellow';
  return acceptsBlueBuzz ? `Blue or ${domain} Buzz` : `${domain} Buzz`;
}

/**
 * The price chip pinned to the corner of a paid-access Download / Create button.
 *
 * Its colour says WHICH Buzz the sale takes (see `paidAccessBuzzBackground`). It used to be a flat
 * yellow everywhere, which told buyers holding only Blue Buzz they couldn't pay — and told .green
 * buyers the wrong colour. White text, because dark text disappeared on the Blue half.
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
  const { isGreen } = useFeatureFlags();
  const amount = abbreviateNumber(price, decimals != null ? { decimals } : undefined);

  const currencyLabel = paidAccessBuzzLabel({ isGreen, acceptsBlueBuzz });
  const tooltip = listedOnly
    ? `Buyers pay ${amount} ${currencyLabel}`
    : `${amount} ${currencyLabel}`;

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        radius="sm"
        size="sm"
        variant="filled"
        style={{
          position: 'absolute',
          top: '-8px',
          right: '-8px',
          boxShadow: theme.shadows.sm,
          padding: '4px 2px',
          paddingRight: '6px',
          background: paidAccessBuzzBackground({ isGreen, acceptsBlueBuzz }),
          // Keeps white legible over the light end of Yellow.
          textShadow: '0 1px 1px rgba(0, 0, 0, 0.35)',
        }}
      >
        <Group gap={0} wrap="nowrap">
          <IconBolt style={{ fill: theme.white }} color="white" size={14} />{' '}
          <Text size="xs" fz={11} c="white">
            {amount}
          </Text>
        </Group>
      </Badge>
    </Tooltip>
  );
}
