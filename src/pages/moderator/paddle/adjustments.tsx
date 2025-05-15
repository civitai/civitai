import {
  Anchor,
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { usePaddleAdjustmentsInfinite } from '~/components/Paddle/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

import { AdjustmentAction, GetPaddleAdjustmentsSchema } from '~/server/schema/paddle.schema';
import { formatDate } from '~/utils/date-helpers';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { getDisplayName, toPascalCase } from '~/utils/string-helpers';

export default function ModeratorPaddleAdjustments() {
  const [filters, setFilters] = useState<GetPaddleAdjustmentsSchema>({
    limit: 50,
    customerId: [],
    subscriptionId: [],
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { adjustments, isLoading, isFetching, fetchNextPage, hasNextPage } =
    usePaddleAdjustmentsInfinite(debouncedFilters);
  const featureFlags = useFeatureFlags();

  if (!featureFlags.paddleAdjustments) {
    return <NotFound />;
  }

  return (
    <>
      <Meta title="Paddle Adjustments | Moderator" deIndex />

      <Container size="lg">
        <Stack gap={0} mb="xl">
          <Title order={1}>Paddle Adjustments</Title>
          <Text size="sm" color="dimmed">
            Includes refunds and Cashbacks we&rsquo;ve seen on Paddle. This mainly because Paddle
            has no way to check this on their platform.
          </Text>
        </Stack>
        <Group justify="space-between" my="md">
          <Group>
            <TextInput
              label="Filter by Customer Id"
              description="Comma separated list of customer IDs"
              value={filters.customerId?.join(',') ?? ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  customerId: e.target.value ? e.target.value.split(',') : undefined,
                })
              }
              size="sm"
              disabled={isLoading}
            />
            <TextInput
              label="Filter by Subscription Id"
              description="Comma separated list of subscription IDs"
              value={filters.subscriptionId?.join(',') ?? ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  subscriptionId: e.target.value ? e.target.value.split(',') : undefined,
                })
              }
              size="sm"
              disabled={isLoading}
            />
            <TextInput
              label="Filter by Transaction Id"
              description="Comma separated list of transaction IDs"
              value={filters.transactionId?.join(',') ?? ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  transactionId: e.target.value ? e.target.value.split(',') : undefined,
                })
              }
              size="sm"
              disabled={isLoading}
            />
          </Group>
          <Select
            label="Type"
            name="size"
            data={[
              { value: 'all', label: 'All' },
              ...AdjustmentAction.map((action) => ({
                value: action as string,
                label: toPascalCase(action.replace('_', ' ')),
              })),
            ]}
            value={filters.action ?? 'all'}
            onChange={(value) =>
              setFilters({
                ...filters,
                action: value === 'all' ? undefined : (value as (typeof AdjustmentAction)[number]),
              })
            }
            disabled={isLoading}
          />
        </Group>

        {isLoading ? (
          <Center p="xl">
            <Loader size="lg" />
          </Center>
        ) : !!adjustments.length ? (
          <Stack>
            <Table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Created at</th>
                  <th>Currency</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Customer</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment) => {
                  return (
                    <tr key={adjustment.id}>
                      <td>{toPascalCase(adjustment.action.replace('_', ' '))}</td>
                      <td>{formatDate(adjustment.createdAt)}</td>
                      <td>{adjustment.currencyCode ?? 'N/A'}</td>
                      <td>
                        {adjustment.payoutTotals?.total
                          ? formatPriceForDisplay(parseInt(adjustment.payoutTotals?.total, 10))
                          : 'N/A'}
                      </td>
                      <td>
                        <Badge>{getDisplayName(adjustment.status.replace('_', ' '))}</Badge>
                      </td>
                      <td>
                        <Stack gap={0}>
                          <Anchor
                            size="xs"
                            // Not keen on this approach, but will have to do in the meantime.
                            href={`https://vendors.paddle.com/customers-v2/${adjustment.customerId}`}
                            target="_blank"
                            rel="nofollow noreferrer"
                          >
                            Paddle
                          </Anchor>
                          <Anchor
                            href={`/moderator/paddle/customer/${adjustment.customerId}`}
                            size="xs"
                            target="_blank"
                          >
                            Civitai
                          </Anchor>
                          <Anchor
                            size="xs"
                            // Not keen on this approach, but will have to do in the meantime.
                            href={`/moderator/paddle/customer/${adjustment.customerId}?app=retool`}
                            target="_blank"
                            rel="nofollow noreferrer"
                          >
                            Retool
                          </Anchor>
                        </Stack>
                      </td>
                      <td>{adjustment.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            {isFetching && !isLoading && (
              <Center>
                <Loader size="md" />
              </Center>
            )}
            <Center>
              <Stack>
                {!hasNextPage && (
                  <Text size="sm" color="dimmed">
                    No more adjustments
                  </Text>
                )}
                <Button
                  loading={isFetching || isLoading}
                  variant="light"
                  onClick={() => fetchNextPage()}
                  disabled={!hasNextPage}
                >
                  Load more
                </Button>
              </Stack>
            </Center>
          </Stack>
        ) : (
          <Paper p="xl" withBorder>
            <Center>
              <Text size="md" color="dimmed">
                No adjustments found
              </Text>
            </Center>
          </Paper>
        )}
      </Container>
    </>
  );
}
