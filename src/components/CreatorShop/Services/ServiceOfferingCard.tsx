import { Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ServiceOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { serviceTermsLine } from '~/components/CreatorShop/Services/creator-service.util';
import { Currency } from '~/shared/utils/prisma/enums';

export function ServiceOfferingCard({
  offering,
  footer,
}: {
  offering: Pick<
    ServiceOffering,
    'title' | 'description' | 'price' | 'deliveryDays' | 'revisionsIncluded'
  >;
  footer?: ReactNode;
}) {
  return (
    <Paper withBorder radius="md" p="md" className="flex h-full flex-col">
      <Stack gap={6} className="flex-1">
        <Text fw={700} lineClamp={2}>
          {offering.title}
        </Text>
        <Text size="sm" c="dimmed">
          {serviceTermsLine(offering)}
        </Text>
        <Text size="sm" lineClamp={4} className="whitespace-pre-line">
          {offering.description}
        </Text>
        <Group justify="space-between" mt="auto" pt="xs" wrap="nowrap">
          <CurrencyBadge
            currency={Currency.BUZZ}
            type="yellow"
            unitAmount={offering.price}
            variant="transparent"
            className="!px-0"
          />
        </Group>
      </Stack>
      {footer}
    </Paper>
  );
}
