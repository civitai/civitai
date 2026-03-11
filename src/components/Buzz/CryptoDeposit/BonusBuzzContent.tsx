import { Badge, Group, Stack, Text } from '@mantine/core';

import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { numberWithCommas } from '~/utils/number-helpers';

export type BonusBuzzContentProps = {
  bonusBuzz: number;
  /** Multiplier as integer, e.g. 120 = 1.20x */
  multiplier: number;
};

export function BonusBuzzContent({ bonusBuzz, multiplier }: BonusBuzzContentProps) {
  const bonusPercent = multiplier - 100;

  return (
    <Stack gap="xs" pt="xs" pb={0} px={0} align="center">
      <Group gap={6} justify="center" wrap="nowrap">
        <Text fw={800} size="24px" c="yellow" lh={1}>
          +
        </Text>
        <CurrencyIcon currency="BUZZ" size={24} />
        <Text fw={800} size="24px" c="yellow" lh={1}>
          {numberWithCommas(bonusBuzz)}
        </Text>
      </Group>

      <Badge
        color="yellow"
        variant="light"
        size="lg"
        radius="sm"
        tt="uppercase"
        fw={700}
        styles={{ label: { letterSpacing: '0.04em' } }}
      >
        {bonusPercent}% Member Bonus
      </Badge>

      <Text size="xs" c="yellow.4" ta="center" maw={240} lh={1.4}>
        Your membership earns you extra Buzz on every crypto deposit
      </Text>
    </Stack>
  );
}
