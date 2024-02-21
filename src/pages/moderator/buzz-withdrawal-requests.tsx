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
  Popover,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { BuzzWithdrawalRequestStatus, Currency } from '@prisma/client';
import { IconCashBanknote, IconExternalLink } from '@tabler/icons-react';
import { IconInfoSquareRounded } from '@tabler/icons-react';
import { IconCashBanknoteOff, IconCheck, IconCloudOff, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { BuzzWithdrawalRequestFilterDropdown } from '~/components/Buzz/WithdrawalRequest/BuzzWithdrawalRequestFiltersDropdown';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryBuzzWithdrawalRequests,
} from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { WithdrawalRequestBadgeColor } from '~/components/Buzz/buzz.styles';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import type { BuzzWithdrawalRequestForModerator } from '~/server/services/buzz-withdrawal-request.service';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';

import {
  formatCurrencyForDisplay,
  getBuzzWithdrawalDetails,
  numberWithCommas,
} from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

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

const RequestHistory = ({ request }: { request: BuzzWithdrawalRequestForModerator }) => {
  return (
    <Popover width={300} withArrow withinPortal shadow="sm">
      <Popover.Target>
        <ActionIcon color="gray">
          <IconInfoSquareRounded size={20} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack spacing="xs">
          <Text size="sm" weight={500}>
            History
          </Text>
          {request.history.map((record) => (
            <Stack key={record.id}>
              <Group noWrap position="apart">
                <UserAvatar
                  user={record.updatedBy}
                  size="xs"
                  subText={`Actioned on ${formatDate(record.createdAt)}`}
                  withUsername
                />

                <Badge size="xs" color={WithdrawalRequestBadgeColor[record.status]} variant="light">
                  {getDisplayName(record.status)}
                </Badge>
              </Group>
              {record.note && (
                <Text size="xs">
                  <Text weight={500}>Note:</Text> {record.note}
                </Text>
              )}
              <Divider />
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};

export default function ModeratorBuzzWithdrawalRequests() {
  const queryUtils = trpc.useContext();
  const features = useFeatureFlags();
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
        color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Approved]}
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
        color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Rejected]}
      >
        <IconX />
      </ActionIcon>
    </Tooltip>
  );

  const revertBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Revert stripe transfer. Use with care" key="revert-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Reverted);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Reverted]}
          key="revert-btn"
        >
          <IconCashBanknoteOff />
        </ActionIcon>
      </Tooltip>
    ) : null;

  const transferBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Send requested money through stripe" key="transfer-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.Transferred);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Transferred]}
        >
          <IconCashBanknote />
        </ActionIcon>
      </Tooltip>
    ) : null;

  const externallyResolvedBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Resolved externally" key="externally-resolved-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest(requestId, BuzzWithdrawalRequestStatus.ExternallyResolved);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.ExternallyResolved]}
        >
          <IconExternalLink size={22} />
        </ActionIcon>
      </Tooltip>
    ) : null;

  return (
    <Container size="lg">
      <Stack spacing={0} mb="xl">
        <Title order={1}>User Buzz Withdrawal Requests</Title>
        <Text size="sm" color="dimmed">
          Review and approve or decline user withdrawal requests. You can also view a
          request&rsquo;s details and history as well as the user&rsquo;s account details.
        </Text>
      </Stack>
      <Group position="apart" mb="md">
        <Group>
          <TextInput
            label="Filter by username"
            value={filters.username ?? ''}
            onChange={(e) => setFilters({ ...filters, username: e.target.value || undefined })}
            size="sm"
          />
          <TextInput
            label="Filter by request ID"
            value={filters.requestId ?? ''}
            onChange={(e) => setFilters({ ...filters, requestId: e.target.value || undefined })}
            size="sm"
          />
        </Group>
        <BuzzWithdrawalRequestFilterDropdown
          setFilters={(f) => setFilters({ ...filters, ...f })}
          filters={filters}
        />
      </Group>
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
                <th>Requested by</th>
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
                const buttons = (
                  request.status === BuzzWithdrawalRequestStatus.Requested
                    ? [
                        approveBtn(request.id),
                        rejectBtn(request.id),
                        transferBtn(request.id),
                        externallyResolvedBtn(request.id),
                      ]
                    : request.status === BuzzWithdrawalRequestStatus.Approved
                    ? [
                        rejectBtn(request.id),
                        transferBtn(request.id),
                        externallyResolvedBtn(request.id),
                      ]
                    : request.status === BuzzWithdrawalRequestStatus.Transferred
                    ? [revertBtn(request.id)]
                    : // Reverted,
                      // Rejected,
                      // Canceled,
                      // Externally resolved
                      []
                ).filter(isDefined);

                const { dollarAmount, platformFee, payoutAmount } = getBuzzWithdrawalDetails(
                  request.requestedBuzzAmount,
                  request.platformFeeRate
                );

                const showColorTransferedAmount = [
                  BuzzWithdrawalRequestStatus.Transferred,
                  BuzzWithdrawalRequestStatus.Reverted,
                ].some((t) => t === request.status);

                return (
                  <tr key={request.id}>
                    <td>
                      <UserAvatar size="sm" user={request.user} withUsername />
                    </td>
                    <td>{formatDate(request.createdAt)}</td>
                    <td>{numberWithCommas(request.requestedBuzzAmount)}</td>
                    <td>{numberWithCommas(request.platformFeeRate / 100)}%</td>
                    <td>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</td>
                    <td>${formatCurrencyForDisplay(platformFee, Currency.USD)}</td>
                    <td>
                      <Text
                        color={
                          showColorTransferedAmount
                            ? WithdrawalRequestBadgeColor[request.status]
                            : undefined
                        }
                        weight={showColorTransferedAmount ? 'bold' : undefined}
                      >
                        $
                        {formatCurrencyForDisplay(
                          request.transferredAmount ?? payoutAmount,
                          Currency.USD
                        )}
                      </Text>
                    </td>
                    <td>
                      <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                        {getDisplayName(request.status)}
                      </Badge>
                    </td>
                    <td align="right">
                      <Group noWrap>
                        {buttons.map((btn) => btn)}
                        <RequestHistory request={request} />
                      </Group>
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
