import type { TooltipProps } from '@mantine/core';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Center,
  Checkbox,
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
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconCashBanknote,
  IconCashBanknoteOff,
  IconCheck,
  IconCloudOff,
  IconExternalLink,
  IconInfoTriangleFilled,
  IconX,
} from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { useState } from 'react';
import { BuzzWithdrawalRequestFilterDropdown } from '~/components/Buzz/WithdrawalRequest/BuzzWithdrawalRequestFiltersDropdown';
import BuzzWithdrawalRequestHistory from '~/components/Buzz/WithdrawalRequest/BuzzWithdrawalRequestHistory';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryBuzzWithdrawalRequests,
} from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { WithdrawalRequestBadgeColor } from '~/components/Buzz/buzz.styles';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SortFilter } from '~/components/Filters';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BuzzWithdrawalRequestSort } from '~/server/common/enums';
import type { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import {
  BuzzWithdrawalRequestStatus,
  Currency,
  UserPaymentConfigurationProvider,
} from '~/shared/utils/prisma/enums';
import { getBuzzWithdrawalDetails } from '~/utils/buzz';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';

import { formatCurrencyForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
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
  requestIds,
  status,
}: {
  requestIds: string[];
  status: BuzzWithdrawalRequestStatus;
}) => {
  const dialog = useDialogContext();
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
      requestIds,
      status,
      note,
    });

    handleSuccess();
  };

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="md">
      <Group justify="space-between" mb="md">
        <Text size="lg" fw="bold">
          Confirm the status change
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      <Stack>
        <Text>
          You are about to set{' '}
          <Text component="span" fw="bold">
            ({requestIds.length})
          </Text>{' '}
          withdrawal request to{' '}
          <Text component="span" fw="bold" c={WithdrawalRequestBadgeColor[status]}>
            {getDisplayName(status)}
          </Text>
          .
        </Text>
        <Stack gap={0}>
          <Textarea
            name="note"
            label="Add a note (optional)"
            placeholder="If you want to keep a record as to why you're updating this request, you can add a note here."
            rows={2}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            description="If multiple requests are being updated, this note will be added to all of them."
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
  const features = useFeatureFlags();
  const [filters, setFilters] = useState<Omit<GetPaginatedBuzzWithdrawalRequestSchema, 'limit'>>({
    page: 1,
    sort: BuzzWithdrawalRequestSort.Newest,
    from: dayjs().startOf('month').toDate(),
    to: new Date(),
  });
  const [selection, setSelection] = useState<{
    enabled: boolean;
    values: string[];
  }>({
    enabled: false,
    values: [],
  });

  const selectionEnabled = selection.enabled;
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { requests, pagination, isLoading, isRefetching } =
    useQueryBuzzWithdrawalRequests(debouncedFilters);

  const handleUpdateRequest = (requestIds: string[], status: BuzzWithdrawalRequestStatus) => {
    dialogStore.trigger({
      component: UpdateBuzzWithdrawalRequest,
      props: { requestIds, status },
    });

    setSelection({ enabled: false, values: [] });
  };

  const approveBtn = (requestIds: string[]) => {
    return (
      <Tooltip
        label="Approve withdrawal request. Money will not be sent by performing this action."
        key="approve-btn"
        {...tooltipProps}
      >
        <LegacyActionIcon
          onClick={() => {
            handleUpdateRequest(requestIds, BuzzWithdrawalRequestStatus.Approved);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Approved]}
        >
          <IconCheck />
        </LegacyActionIcon>
      </Tooltip>
    );
  };
  const rejectBtn = (requestIds: string[]) => {
    return (
      <Tooltip label="Reject withdrawal request." key="reject-btn" {...tooltipProps}>
        <LegacyActionIcon
          onClick={() => {
            handleUpdateRequest(requestIds, BuzzWithdrawalRequestStatus.Rejected);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Rejected]}
        >
          <IconX />
        </LegacyActionIcon>
      </Tooltip>
    );
  };

  const revertBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Revert stripe transfer. Use with care" key="revert-btn" {...tooltipProps}>
        <LegacyActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.Reverted);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Reverted]}
          key="revert-btn"
        >
          <IconCashBanknoteOff />
        </LegacyActionIcon>
      </Tooltip>
    ) : null;

  const transferBtn = (requestId: string) => {
    const request = requests.find((r) => r.id === requestId);
    return features.buzzWithdrawalTransfer ? (
      <Tooltip
        label={`Send requested money through ${request?.requestedToProvider ?? 'stripe'}`}
        key="transfer-btn"
        {...tooltipProps}
      >
        <LegacyActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.Transferred);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Transferred]}
        >
          <IconCashBanknote />
        </LegacyActionIcon>
      </Tooltip>
    ) : null;
  };

  const externallyResolvedBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Resolved externally" key="externally-resolved-btn" {...tooltipProps}>
        <LegacyActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.ExternallyResolved);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.ExternallyResolved]}
        >
          <IconExternalLink size={22} />
        </LegacyActionIcon>
      </Tooltip>
    ) : null;

  return (
    <Container size="lg">
      <Stack gap={0} mb="xl">
        <Title order={1}>User Buzz Withdrawal Requests</Title>
        <Text size="sm" c="dimmed">
          Review and approve or decline user withdrawal requests. You can also view a
          request&rsquo;s details and history as well as the user&rsquo;s account details.
        </Text>
      </Stack>
      <Stack mb="md">
        <Group className="ml-auto">
          <SortFilter
            type="buzzWithdrawalRequests"
            value={filters.sort}
            disabled={selectionEnabled}
            onChange={(x) => setFilters({ ...filters, sort: x as BuzzWithdrawalRequestSort })}
          />
          <BuzzWithdrawalRequestFilterDropdown
            setFilters={(f) => setFilters({ ...filters, ...f })}
            filters={filters}
            disabled={selectionEnabled}
          />

          <Button
            variant="light"
            onClick={() =>
              setSelection((curr) => ({ ...curr, enabled: !curr.enabled, values: [] }))
            }
            radius="lg"
          >
            {selectionEnabled ? 'Cancel' : 'Bulk-Select'}
          </Button>

          {selection.values.length > 0 && (
            <Group>
              <Button
                variant="light"
                color="green"
                onClick={() =>
                  handleUpdateRequest(selection.values, BuzzWithdrawalRequestStatus.Approved)
                }
                radius="lg"
              >
                Approve ({selection.values.length})
              </Button>
              <Button
                variant="light"
                color="red"
                onClick={() =>
                  handleUpdateRequest(selection.values, BuzzWithdrawalRequestStatus.Rejected)
                }
                radius="lg"
              >
                Reject ({selection.values.length})
              </Button>
            </Group>
          )}
        </Group>
        <Group justify="space-between">
          <Group>
            <DatePickerInput
              label="From"
              placeholder="Start date"
              value={filters.from ?? undefined}
              onChange={(date) => {
                setFilters({ ...filters, from: date ?? undefined });
              }}
              disabled={selectionEnabled}
              clearable
            />
            <DatePickerInput
              label="To"
              placeholder="End date"
              value={filters.to ?? undefined}
              onChange={(date) => {
                setFilters({ ...filters, to: date ?? undefined });
              }}
              disabled={selectionEnabled}
              clearable
            />
            <TextInput
              label="Filter by username"
              value={filters.username ?? ''}
              onChange={(e) => setFilters({ ...filters, username: e.target.value || undefined })}
              size="sm"
              disabled={selectionEnabled}
            />
            <TextInput
              label="Filter by request ID"
              value={filters.requestId ?? ''}
              onChange={(e) => setFilters({ ...filters, requestId: e.target.value || undefined })}
              size="sm"
              disabled={selectionEnabled}
            />
          </Group>
        </Group>
      </Stack>
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
                <Table.Th>Requested by</Table.Th>
                <Table.Th>Requested at</Table.Th>
                <Table.Th>Buzz Amount</Table.Th>
                <Table.Th>Platform fee rate</Table.Th>
                <Table.Th>Dollar Amount Total</Table.Th>
                <Table.Th>Application Fee</Table.Th>
                <Table.Th>Transfer amount</Table.Th>
                <Table.Th>Provider</Table.Th>

                <Table.Th>Status</Table.Th>
                <Table.Th>&nbsp;</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {requests.map((request) => {
                const buttons = (
                  request.status === BuzzWithdrawalRequestStatus.Requested
                    ? request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
                      ? [
                          approveBtn([request.id]),
                          rejectBtn([request.id]),
                          externallyResolvedBtn(request.id),
                        ]
                      : [approveBtn([request.id]), rejectBtn([request.id]), transferBtn(request.id)]
                    : request.status === BuzzWithdrawalRequestStatus.Approved
                    ? request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
                      ? [externallyResolvedBtn(request.id)]
                      : [
                          rejectBtn([request.id]),
                          transferBtn(request.id),
                          externallyResolvedBtn(request.id),
                        ]
                    : request.status === BuzzWithdrawalRequestStatus.Transferred
                    ? request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
                      ? []
                      : [revertBtn(request.id)]
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

                const isSelected = selection.values.includes(request.id);

                return (
                  <Table.Tr key={request.id}>
                    <Table.Td>
                      <Stack gap={0}>
                        <UserAvatar size="sm" user={request.user} withUsername linkToProfile />
                        {request.requestedToProvider ===
                          UserPaymentConfigurationProvider.Tipalti && (
                          <Anchor
                            href={`https://aphub2.tipalti.com/dashboard/payees/information/${request.user?.id}/payments`}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            <Group gap={2} wrap="nowrap">
                              <IconExternalLink size={16} /> <Text size="sm">Tipalti Account</Text>
                            </Group>
                          </Anchor>
                        )}
                      </Stack>
                    </Table.Td>
                    <Table.Td>{formatDate(request.createdAt)}</Table.Td>
                    <Table.Td>{numberWithCommas(request.requestedBuzzAmount)}</Table.Td>
                    <Table.Td>{numberWithCommas(request.platformFeeRate / 100)}%</Table.Td>
                    <Table.Td>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</Table.Td>
                    <Table.Td>${formatCurrencyForDisplay(platformFee, Currency.USD)}</Table.Td>
                    <Table.Td>
                      <Text
                        color={
                          showColorTransferedAmount
                            ? WithdrawalRequestBadgeColor[request.status]
                            : undefined
                        }
                        fw={showColorTransferedAmount ? 'bold' : undefined}
                      >
                        $
                        {formatCurrencyForDisplay(
                          request.transferredAmount ?? payoutAmount,
                          Currency.USD
                        )}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text>{request.requestedToProvider}</Text>
                        {request.requestedToProvider ===
                          UserPaymentConfigurationProvider.Tipalti && (
                          <Tooltip
                            maw={300}
                            multiline
                            withArrow
                            withinPortal
                            label="Once approved, Tipalti items must be resolved in the Tipalti dashboard. Resolving them there will update the status here automatically."
                          >
                            <LegacyActionIcon color="blue">
                              <IconInfoTriangleFilled size={16} />
                            </LegacyActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                        {getDisplayName(request.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td align="right">
                      {selectionEnabled ? (
                        <Checkbox
                          checked={isSelected}
                          onChange={() => {
                            setSelection((curr) => ({
                              ...curr,
                              values: !isSelected
                                ? [...curr.values, request.id]
                                : curr.values.filter((v) => v !== request.id),
                            }));
                          }}
                          disabled={request.status !== BuzzWithdrawalRequestStatus.Requested}
                          radius="lg"
                        />
                      ) : (
                        <Group wrap="nowrap">
                          {buttons}
                          <BuzzWithdrawalRequestHistory history={request.history} />
                        </Group>
                      )}
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
    </Container>
  );
}
