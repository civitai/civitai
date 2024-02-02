import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  Pagination,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { BuzzWithdrawalRequestStatus, Currency } from '@prisma/client';
import { IconCashBanknote } from '@tabler/icons-react';
import { IconCashBanknoteOff, IconCheck, IconCloudOff, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryBuzzWithdrawalRequests,
} from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { WithdrawalRequestBadgeColor } from '~/components/Buzz/buzz.styles';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';

import {
  formatCurrencyForDisplay,
  getBuzzWithdrawalDetails,
  numberWithCommas,
} from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const tooltipProps: Partial<TooltipProps> = {
  position: 'top',
  maw: 250,
  withArrow: true,
  multiline: true,
  // @ts-ignore This works fine.
  align: 'center',
};

const UpdateBuzzWithdrawalRequest = ({
  requestId,
  status,
}: {
  requestId: string;
  status: BuzzWithdrawalRequestStatus;
}) => {
  const dialog = useDialogContext();
  const utils = trpc.useContext();
  const handleClose = dialog.onClose;
  const [note, setNote] = useState('');
  const { updateBuzzWithdrawalRequest, updatingBuzzWithdrawalRequest } =
    useMutateBuzzWithdrawalRequest();

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Buzz withdrawal request updated successfully!',
      message: 'The user will be notified of these changes.',
    });

    handleClose();
  };

  const handleSubmit = async () => {
    await updateBuzzWithdrawalRequest({
      requestId,
      status,
      note,
    });

    handleSuccess();
  };

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="md">
      <Group position="apart" mb="md">
        <Text size="lg" weight="bold">
          Confirm the status change
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      <Stack>
        <Text>
          You are about to set withdrawal request to{' '}
          <Text component="span" weight="bold" color={WithdrawalRequestBadgeColor[status]}>
            {getDisplayName(status)}
          </Text>
          .
        </Text>
        <Stack spacing={0}>
          <Textarea
            name="note"
            label="Add a note (optional)"
            placeholder="If you want to keep a record as to why you're updating this request, you can add a note here."
            rows={2}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </Stack>
        <Group ml="auto">
          <Button
            type="button"
            onClick={handleClose}
            color="gray"
            disabled={updatingBuzzWithdrawalRequest}
          >
            Cancel update
          </Button>
          <Button onClick={handleSubmit} loading={updatingBuzzWithdrawalRequest}>
            Yes, update
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
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
    dialogStore.trigger({
      component: UpdateBuzzWithdrawalRequest,
      props: { requestId, status },
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
    <Container size="lg">
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
                <th>Platform fee rate</th>
                <th>Dollar Amount Total</th>
                <th>Application Fee</th>
                <th>Transfer amount</th>

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
                    : // Reverted,
                      // Rejected,
                      // Canceled
                      [];

                const { dollarAmount, platformFee, payoutAmount } = getBuzzWithdrawalDetails(
                  request.requestedBuzzAmount,
                  request.platformFeeRate
                );

                return (
                  <tr key={request.id}>
                    <td>{formatDate(request.createdAt)}</td>
                    <td>{numberWithCommas(request.requestedBuzzAmount)}</td>
                    <td>{numberWithCommas(request.platformFeeRate / 100)}%</td>
                    <td>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</td>
                    <td>${formatCurrencyForDisplay(platformFee, Currency.USD)}</td>
                    <td>${formatCurrencyForDisplay(payoutAmount, Currency.USD)}</td>
                    <td>
                      <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                        {getDisplayName(request.status)}
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
