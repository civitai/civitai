import { Anchor, Badge, Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  dealStatusLabel,
  visibleDealActions,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import { useMyServiceDeals } from '~/components/CreatorShop/Services/deals/deal.util';
import { NextLink } from '~/components/NextLink/NextLink';
import { pluralize } from '~/components/CreatorShop/Services/creator-service.util';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { useServerDomains } from '~/providers/AppProvider';
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
  const { deals, hiddenOffDomain, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMyServiceDeals({ role, status, enabled: true });
  const redDomain = useServerDomains().red;
  const syncAccount = useSyncAccount();
  // Mature deals are left out off red; say where they went so a party doesn't think one vanished.
  const offDomainLine = hiddenOffDomain > 0 && (
    <Text size="sm" c="dimmed">
      <Anchor href={syncAccount(`//${redDomain}/services/deals`)} inherit>
        {pluralize(hiddenOffDomain, 'deal')} on civitai.red
      </Anchor>
    </Text>
  );

  if (isLoading)
    return (
      <Center py="lg">
        <Loader size="sm" />
      </Center>
    );
  if (deals.length === 0)
    return (
      offDomainLine || (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      )
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
      {offDomainLine}
    </Stack>
  );
}
