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
  TooltipProps,
} from '@mantine/core';
import { DatePicker } from '@mantine/dates';
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
import dayjs from 'dayjs';
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
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BuzzWithdrawalRequestSort } from '~/server/common/enums';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import {
  BuzzWithdrawalRequestStatus,
  Currency,
  UserPaymentConfigurationProvider,
} from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';

import {
  formatCurrencyForDisplay,
  getBuzzWithdrawalDetails,
  numberWithCommas,
} from '~/utils/number-helpers';
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
      <Group position="apart" mb="md">
        <Text size="lg" weight="bold">
          Confirm the status change
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      <Stack>
        <Text>
          You are about to set{' '}
          <Text component="span" weight="bold">
            ({requestIds.length})
          </Text>{' '}
          withdrawal request to{' '}
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
        <ActionIcon
          onClick={() => {
            handleUpdateRequest(requestIds, BuzzWithdrawalRequestStatus.Approved);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Approved]}
        >
          <IconCheck />
        </ActionIcon>
      </Tooltip>
    );
  };
  const rejectBtn = (requestIds: string[]) => {
    return (
      <Tooltip label="Reject withdrawal request." key="reject-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest(requestIds, BuzzWithdrawalRequestStatus.Rejected);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Rejected]}
        >
          <IconX />
        </ActionIcon>
      </Tooltip>
    );
  };

  const revertBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Revert stripe transfer. Use with care" key="revert-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.Reverted);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Reverted]}
          key="revert-btn"
        >
          <IconCashBanknoteOff />
        </ActionIcon>
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
        <ActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.Transferred);
          }}
          color={WithdrawalRequestBadgeColor[BuzzWithdrawalRequestStatus.Transferred]}
        >
          <IconCashBanknote />
        </ActionIcon>
      </Tooltip>
    ) : null;
  };

  const externallyResolvedBtn = (requestId: string) =>
    features.buzzWithdrawalTransfer ? (
      <Tooltip label="Resolved externally" key="externally-resolved-btn" {...tooltipProps}>
        <ActionIcon
          onClick={() => {
            handleUpdateRequest([requestId], BuzzWithdrawalRequestStatus.ExternallyResolved);
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
      <Stack mb="md">
        <Group className="ml-auto">
          <SortFilter
            type="buzzWithdrawalRequests"
            variant="button"
            value={filters.sort}
            buttonProps={{ compact: false, disabled: selectionEnabled }}
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
        <Group position="apart">
          <Group>
            <DatePicker
              label="From"
              placeholder="Start date"
              value={filters.from ?? undefined}
              onChange={(date) => {
                setFilters({ ...filters, from: date ?? undefined });
              }}
              clearButtonLabel="Clear"
              disabled={selectionEnabled}
            />
            <DatePicker
              label="To"
              placeholder="End date"
              value={filters.to ?? undefined}
              onChange={(date) => {
                setFilters({ ...filters, to: date ?? undefined });
              }}
              clearButtonLabel="Clear"
              disabled={selectionEnabled}
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
            <thead>
              <tr>
                <th>Requested by</th>
                <th>Requested at</th>
                <th>Buzz Amount</th>
                <th>Platform fee rate</th>
                <th>Dollar Amount Total</th>
                <th>Application Fee</th>
                <th>Transfer amount</th>
                <th>Provider</th>

                <th>Status</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
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
                  <tr key={request.id}>
                    <td>
                      <Stack spacing={0}>
                        <UserAvatar size="sm" user={request.user} withUsername linkToProfile />
                        {request.requestedToProvider ===
                          UserPaymentConfigurationProvider.Tipalti && (
                          <Anchor
                            href={`https://aphub2.tipalti.com/dashboard/payees/information/${request.user?.id}/payments`}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            <Group spacing={2} noWrap>
                              <IconExternalLink size={16} /> <Text size="sm">Tipalti Account</Text>
                            </Group>
                          </Anchor>
                        )}
                      </Stack>
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
                      <Group spacing="xs" noWrap>
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
                            <ActionIcon color="blue">
                              <IconInfoTriangleFilled size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </td>
                    <td>
                      <Badge variant="light" color={WithdrawalRequestBadgeColor[request.status]}>
                        {getDisplayName(request.status)}
                      </Badge>
                    </td>
                    <td align="right">
                      {selectionEnabled ? (
                        <Checkbox
                          checked={isSelected}
                          onChange={(event) => {
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
                        <Group noWrap>
                          {buttons}
                          <BuzzWithdrawalRequestHistory history={request.history} />
                        </Group>
                      )}
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
