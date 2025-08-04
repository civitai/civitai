import {
  Badge,
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
import { openConfirmModal } from '@mantine/modals';
import { IconCloudOff } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import BuzzWithdrawalRequestHistory from '~/components/Buzz/WithdrawalRequest/BuzzWithdrawalRequestHistory';
import { CreateWithdrawalRequest } from '~/components/Buzz/WithdrawalRequest/CreateWithdrawalRequest';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useUserPaymentConfiguration } from '~/components/UserPaymentConfiguration/util';
import { BuzzWithdrawalRequestStatus, Currency } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';
import type { GetPaginatedOwnedBuzzWithdrawalRequestSchema } from '../../../server/schema/buzz-withdrawal-request.schema';
import { formatDate } from '../../../utils/date-helpers';
import { formatCurrencyForDisplay, numberWithCommas } from '../../../utils/number-helpers';
import classes from '~/components/Buzz/buzz.module.scss';
import { WithdrawalRequestBadgeColor } from '../buzz.styles';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryOwnedBuzzWithdrawalRequests,
} from '../WithdrawalRequest/buzzWithdrawalRequest.util';
import { getBuzzWithdrawalDetails } from '~/utils/buzz';

export function OwnedBuzzWithdrawalRequestsPaged() {
  const { userPaymentConfiguration } = useUserPaymentConfiguration();
  const [filters, setFilters] = useState<
    Omit<GetPaginatedOwnedBuzzWithdrawalRequestSchema, 'limit'>
  >({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { requests, pagination, isLoading, isRefetching } =
    useQueryOwnedBuzzWithdrawalRequests(debouncedFilters);

  const { cancelingBuzzWithdrawalRequest, cancelBuzzWithdrawalRequest } =
    useMutateBuzzWithdrawalRequest();

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  const handleCancelRequest = (id: string) => {
    openConfirmModal({
      title: 'Cancel withdrawal request',
      children: <Text size="sm">Are you sure you want to cancel this withdrawal request?</Text>,
      centered: true,
      labels: { confirm: 'Cancel request', cancel: "No, don't cancel it" },
      confirmProps: { color: 'red' },
      closeOnConfirm: true,
      onConfirm: async () => {
        await cancelBuzzWithdrawalRequest({ id });
        showSuccessNotification({
          title: 'Withdrawal request canceled',
          message: 'Withdrawal request has been canceled successfully and Buzz has been refunded.',
        });
      },
    });
  };

  if (!userPaymentConfiguration || !userPaymentConfiguration.tipaltiPaymentsEnabled) {
    return null;
  }

  return (
    <Paper withBorder p="lg" radius="md" className={classes.tileCard} id="buzz-withdrawals">
      <Stack gap="sm">
        <Group justify="space-between">
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
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Requested at</Table.Th>
                  <Table.Th>Buzz Amount</Table.Th>
                  <Table.Th>Platform fee rate</Table.Th>
                  <Table.Th>Dollar Amount Total</Table.Th>
                  <Table.Th>Application Fee</Table.Th>
                  <Table.Th>Payout amount</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>&nbsp;</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {requests.map((request) => {
                  const { dollarAmount, platformFee, payoutAmount } = getBuzzWithdrawalDetails(
                    request.requestedBuzzAmount,
                    request.platformFeeRate
                  );

                  const hasReachedStripe = [
                    BuzzWithdrawalRequestStatus.Transferred,
                    BuzzWithdrawalRequestStatus.Reverted,
                  ].some((t) => t === request.status);

                  return (
                    <Table.Tr key={request.id}>
                      <Table.Td>{formatDate(request.createdAt)}</Table.Td>
                      <Table.Td>{numberWithCommas(request.requestedBuzzAmount)}</Table.Td>
                      <Table.Td>{numberWithCommas(request.platformFeeRate / 100)}%</Table.Td>
                      <Table.Td>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</Table.Td>
                      <Table.Td>${formatCurrencyForDisplay(platformFee, Currency.USD)}</Table.Td>
                      <Table.Td>
                        <Stack gap={0}>
                          <Text
                            c={
                              hasReachedStripe
                                ? WithdrawalRequestBadgeColor[request.status]
                                : undefined
                            }
                            fw={hasReachedStripe ? 'bold' : undefined}
                          >
                            ${formatCurrencyForDisplay(payoutAmount, Currency.USD)}{' '}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                          {request.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td align="right">
                        <Group>
                          {request.status === BuzzWithdrawalRequestStatus.Requested && (
                            <Button
                              color="red"
                              onClick={() => {
                                handleCancelRequest(request.id);
                              }}
                              loading={cancelingBuzzWithdrawalRequest}
                              size="xs"
                            >
                              <Text size="sm">Cancel</Text>
                            </Button>
                          )}
                          <BuzzWithdrawalRequestHistory history={request.history} />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
              {pagination && pagination.totalPages > 1 && (
                <Group justify="space-between">
                  <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                  <Pagination
                    value={filters.page}
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
