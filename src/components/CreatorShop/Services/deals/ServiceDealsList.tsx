import { Badge, Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  dealStatusLabel,
  visibleDealActions,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import { useMyServiceDeals } from '~/components/CreatorShop/Services/deals/deal.util';
import { NextLink } from '~/components/NextLink/NextLink';
import { formatDate } from '~/utils/date-helpers';
import { Currency } from '~/shared/utils/prisma/enums';

const deadlineLabel = {
  acceptBy: 'Answer by',
  due: 'Due',
  autoCompleteAt: 'Completes',
  autoCancelAt: 'Cancels',
  disputeUntil: 'Pays out',
} as const;

export function ServiceDealsList({
  role,
  status,
  emptyText,
}: {
  role: 'buyer' | 'seller';
  status?: 'open' | 'closed';
  emptyText: string;
}) {
  const { deals, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useMyServiceDeals({
    role,
    status,
    enabled: true,
  });

  if (isLoading)
    return (
      <Center py="lg">
        <Loader size="sm" />
      </Center>
    );
  if (deals.length === 0)
    return (
      <Text size="sm" c="dimmed">
        {emptyText}
      </Text>
    );

  return (
    <Stack gap="xs">
      {deals.map((deal) => (
        <Paper key={deal.id} withBorder radius="md" p="sm">
          <Group justify="space-between" wrap="nowrap" gap="md">
            <Stack gap={2} className="min-w-0">
              <Group gap="xs" wrap="nowrap">
                <Text fw={600} lineClamp={1}>
                  {deal.offering.title}
                </Text>
                {visibleDealActions(deal.actions, { servicesEnabled: true }).length > 0 ? (
                  <Badge color="yellow" variant="light" radius="sm">
                    Awaiting you
                  </Badge>
                ) : (
                  <Badge color="gray" variant="light" radius="sm">
                    {dealStatusLabel[deal.status]}
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed" lineClamp={1}>
                {role === 'seller' ? 'From' : 'With'} {deal.counterparty.username}
                {deal.nextDeadline &&
                  ` · ${deadlineLabel[deal.nextDeadline.kind]} ${formatDate(
                    deal.nextDeadline.at,
                    'MMM D, h:mm A'
                  )}`}
              </Text>
            </Stack>
            <Group gap="sm" wrap="nowrap">
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={deal.buzzType === 'green' ? 'green' : 'yellow'}
                unitAmount={deal.price}
                variant="transparent"
              />
              <Button
                component={NextLink}
                href={`/services/deals/${deal.id}`}
                size="xs"
                variant="light"
              >
                Open deal
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
      {hasNextPage && (
        <Button variant="subtle" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
          Load more
        </Button>
      )}
    </Stack>
  );
}
