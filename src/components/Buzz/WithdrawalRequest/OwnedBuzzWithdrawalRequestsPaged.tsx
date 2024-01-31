import {
  Button,
  Center,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '../../../server/schema/buzz-withdrawal-request.schema';
import { useQueryOwnedBuzzWithdrawalRequests } from '../WithdrawalRequest/buzzWithdrawalRequest.util';
import { formatDate } from '../../../utils/date-helpers';
import { numberWithCommas } from '../../../utils/number-helpers';
import { useBuzzDashboardStyles } from '../buzz.styles';
import { IconCloudOff } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CreateWithdrawalRequest } from '~/components/Buzz/WithdrawalRequest/CreateWithdrawalRequest';

export function OwnedBuzzWithdrawalRequestsPaged() {
  const { classes } = useBuzzDashboardStyles();
  const utils = trpc.useContext();
  const [filters, setFilters] = useState<Omit<GetPaginatedBuzzWithdrawalRequestSchema, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { requests, pagination, isLoading, isRefetching } =
    useQueryOwnedBuzzWithdrawalRequests(debouncedFilters);

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  const handleRequestCancelled = (id: number) => {
    console.log('Noo!!!');
  };

  return (
    <Paper withBorder p="lg" radius="md" className={classes.tileCard}>
      <Stack spacing="sm">
        <Group position="apart">
          <Title order={2}>Withdrawal Requests</Title>
          <Button
            onClick={() => {
              dialogStore.trigger({
                component: CreateWithdrawalRequest,
              });
            }}
          >
            Withdraw
          </Button>
        </Group>
        <Divider />
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : !!requests.length ? (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
            <Table>
              <thead>
                <tr>
                  <th>Requested at</th>
                  <th>Buzz Amount</th>
                  <th>Status</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => {
                  return (
                    <tr key={request.id}>
                      <td>{formatDate(request.createdAt)}</td>
                      <td>{numberWithCommas(request.requestedBuzzAmount)}</td>
                      <td>{request.status}</td>
                      <td>...</td>
                    </tr>
                  );
                })}
              </tbody>
              {pagination && pagination.totalPages > 1 && (
                <Group position="apart">
                  <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                  <Pagination
                    page={filters.page}
                    onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                    total={pagination.totalPages}
                  />
                </Group>
              )}
            </Table>
          </div>
        ) : (
          <Stack align="center">
            <ThemeIcon size={62} radius={100}>
              <IconCloudOff />
            </ThemeIcon>
            <Text align="center">Looks like no withdrawal requests have been made. Start now!</Text>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
