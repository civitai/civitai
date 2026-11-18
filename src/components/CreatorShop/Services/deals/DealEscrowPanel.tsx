import { Group, Paper, Stack, Text } from '@mantine/core';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  dealEscrowState,
  escrowCopy,
  sellerHeldLine,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { Currency } from '~/shared/utils/prisma/enums';

export function DealEscrowPanel({ deal }: { deal: ServiceDealView }) {
  const copy = escrowCopy[dealEscrowState(deal)];
  const body = (deal.viewerRole === 'seller' && sellerHeldLine(deal)) || copy.body;
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      className="border-l-4"
      style={{ borderLeftColor: `var(--mantine-color-${copy.color}-6)` }}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Text fw={700}>{copy.title}</Text>
          <CurrencyBadge
            currency={Currency.BUZZ}
            type={deal.buzzType === 'green' ? 'green' : 'yellow'}
            unitAmount={deal.price}
            variant="transparent"
          />
        </Group>
        <Text size="sm" c="dimmed">
          {body}
        </Text>
      </Stack>
    </Paper>
  );
}
