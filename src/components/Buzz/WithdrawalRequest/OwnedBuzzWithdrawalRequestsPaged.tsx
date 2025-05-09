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
import { GetPaginatedOwnedBuzzWithdrawalRequestSchema } from '../../../server/schema/buzz-withdrawal-request.schema';
import { formatDate } from '../../../utils/date-helpers';
import {
  formatCurrencyForDisplay,
  getBuzzWithdrawalDetails,
  numberWithCommas,
} from '../../../utils/number-helpers';
import { useBuzzDashboardStyles, WithdrawalRequestBadgeColor } from '../buzz.styles';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryOwnedBuzzWithdrawalRequests,
} from '../WithdrawalRequest/buzzWithdrawalRequest.util';

export function OwnedBuzzWithdrawalRequestsPaged() {
  const { userPaymentConfiguration } = useUserPaymentConfiguration();
  const { classes } = useBuzzDashboardStyles();
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
              <thead>
                <tr>
                  <th>Requested at</th>
                  <th>Buzz Amount</th>
                  <th>Platform fee rate</th>
                  <th>Dollar Amount Total</th>
                  <th>Application Fee</th>
                  <th>Payout amount</th>
                  <th>Status</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
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
                    <tr key={request.id}>
                      <td>{formatDate(request.createdAt)}</td>
                      <td>{numberWithCommas(request.requestedBuzzAmount)}</td>
                      <td>{numberWithCommas(request.platformFeeRate / 100)}%</td>
                      <td>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</td>
                      <td>${formatCurrencyForDisplay(platformFee, Currency.USD)}</td>
                      <td>
                        <Stack gap={0}>
                          <Text
                            color={
                              hasReachedStripe
                                ? WithdrawalRequestBadgeColor[request.status]
                                : undefined
                            }
                            weight={hasReachedStripe ? 'bold' : undefined}
                          >
                            ${formatCurrencyForDisplay(payoutAmount, Currency.USD)}{' '}
                          </Text>
                        </Stack>
                      </td>
                      <td>
                        <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                          {request.status}
                        </Badge>
                      </td>
                      <td align="right">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {pagination && pagination.totalPages > 1 && (
                <Group justify="space-between">
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
