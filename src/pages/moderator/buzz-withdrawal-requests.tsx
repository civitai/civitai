import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { IconCashBanknote } from '@tabler/icons-react';
import { IconCashBanknoteOff, IconCheck, IconCloudOff, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useQueryBuzzWithdrawalRequests } from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { WithdrawalRequestBadgeColor } from '~/components/Buzz/buzz.styles';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import { formatDate } from '~/utils/date-helpers';

import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const tooltipProps: Partial<TooltipProps> = {
  position: 'top',
  maw: 250,
  withArrow: true,
  multiline: true,
  // @ts-ignore This works fine.
  align: 'center',
};

export default function ModeratorBuzzWithdrawalRequests() {
  const queryUtils = trpc.useContext();
  const [filters, setFilters] = useState<Omit<GetPaginatedBuzzWithdrawalRequestSchema, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { requests, pagination, isLoading, isRefetching } =
    useQueryBuzzWithdrawalRequests(debouncedFilters);

  const handleUpdateRequest = (requestId: string, status: BuzzWithdrawalRequestStatus) => {
    openConfirmModal({
      title: 'Update withdrawal request',
      children: (
        <Stack>
          <Text>
            Are you sure you want to update this request to{' '}
            <Text weight="bold" component="span" color={WithdrawalRequestBadgeColor[status]}>
              {status}
            </Text>
            ?
          </Text>
          <Text size="sm" color="dimmed">
            A history of this action will be recorded to ensure transparency.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Yes, update', cancel: "No, don't update it" },
      onConfirm: () => {
        console.log('OK lets go');
      },
    });
  };

  const approveBtn = (requestId: string) => (
    <Tooltip
      label="Approve withdrawal request. Money will not be sent by performing this action."
      key="approve-btn"
      {...tooltipProps}
    >
      <ActionIcon
        onClick={() => {
          handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Approved);
        }}
        color="blue"
      >
        <IconCheck />
      </ActionIcon>
    </Tooltip>
  );
  const rejectBtn = (requestId: string) => (
    <Tooltip label="Reject withdrawal request." key="reject-btn" {...tooltipProps}>
      <ActionIcon
        onClick={() => {
          handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Rejected);
        }}
        color="red"
      >
        <IconX />
      </ActionIcon>
    </Tooltip>
  );

  const revertBtn = (requestId: string) => (
    <Tooltip label="Revert stripe transfer. Use with care" key="revert-btn" {...tooltipProps}>
      <ActionIcon
        onClick={() => {
          handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Reverted);
        }}
        color="orange"
        key="revert-btn"
      >
        <IconCashBanknoteOff />
      </ActionIcon>
    </Tooltip>
  );
  const transferBtn = (requestId: string) => (
    <Tooltip label="Send requested money through stripe" key="transfer-btn" {...tooltipProps}>
      <ActionIcon
        onClick={() => {
          handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Transferred);
        }}
        color="green"
      >
        <IconCashBanknote />
      </ActionIcon>
    </Tooltip>
  );

  return (
    <Container size="sm">
      <Stack spacing={0} mb="xl">
        <Title order={1}>User Buzz Withdrawal Requests</Title>
        <Text size="sm" color="dimmed">
          Review and approve or decline user withdrawal requests. You can also view a
          request&rsquo;s details and history as well as the user&rsquo;s account details.
        </Text>
      </Stack>
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
                const buttons =
                  request.status === BuzzWithdrawalRequestStatus.Requested
                    ? [approveBtn(request.id), rejectBtn(request.id), transferBtn(request.id)]
                    : request.status === BuzzWithdrawalRequestStatus.Approved
                    ? [rejectBtn(request.id), transferBtn(request.id)]
                    : request.status === BuzzWithdrawalRequestStatus.Transferred
                    ? [revertBtn(request.id)]
                    : request.status === BuzzWithdrawalRequestStatus.Rejected
                    ? [approveBtn(request.id), transferBtn(request.id)]
                    : [];

                return (
                  <tr key={request.id}>
                    <td>{formatDate(request.createdAt)}</td>
                    <td>{numberWithCommas(request.requestedBuzzAmount)}</td>
                    <td>
                      <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                        {request.status}
                      </Badge>
                    </td>
                    <td align="right">
                      <Group>{buttons.map((btn) => btn)}</Group>
                    </td>
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
    </Container>
  );
}
