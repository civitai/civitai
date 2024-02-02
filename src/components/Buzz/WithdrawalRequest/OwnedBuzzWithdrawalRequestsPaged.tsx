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
  Badge,
  Modal,
  ScrollArea,
  Checkbox,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { GetPaginatedOwnedBuzzWithdrawalRequestSchema } from '../../../server/schema/buzz-withdrawal-request.schema';
import {
  useMutateBuzzWithdrawalRequest,
  useQueryOwnedBuzzWithdrawalRequests,
} from '../WithdrawalRequest/buzzWithdrawalRequest.util';
import { formatDate } from '../../../utils/date-helpers';
import {
  formatCurrencyForDisplay,
  getBuzzWithdrawalDetails,
  numberWithCommas,
} from '../../../utils/number-helpers';
import { WithdrawalRequestBadgeColor, useBuzzDashboardStyles } from '../buzz.styles';
import { IconCloudOff } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CreateWithdrawalRequest } from '~/components/Buzz/WithdrawalRequest/CreateWithdrawalRequest';
import { BuzzWithdrawalRequestStatus, Currency } from '@prisma/client';
import { openConfirmModal } from '@mantine/modals';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import ReactMarkdown from 'react-markdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import rehypeRaw from 'rehype-raw';

export const AcceptCodeOfConduct = ({ onAccepted }: { onAccepted: () => void }) => {
  const dialog = useDialogContext();
  const utils = trpc.useContext();
  const currentUser = useCurrentUser();
  const handleClose = dialog.onClose;
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug: 'creators-program-coc',
  });
  const queryUtils = trpc.useContext();

  const updateUserSettings = trpc.user.setSettings.useMutation({
    async onSuccess(res, t2) {
      queryUtils.user.getSettings.setData(undefined, res);
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to accept code of conduct',
        error: new Error('Something went wrong, please try again later.'),
      });
    },
  });
  const handleConfirm = async () => {
    if (!acceptedCoC) {
      return;
    }

    await updateUserSettings.mutate({
      creatorsProgramCodeOfConductAccepted: true,
    });

    handleClose();
    onAccepted();
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
      <Group position="apart" mb="md">
        <Text size="lg" weight="bold">
          Civitai Creator Program Code of Conduct
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      {isLoading || !data?.content ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack spacing="md">
          <ScrollArea.Autosize maxHeight={500}>
            <Stack>
              <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
                {data.content}
              </ReactMarkdown>
              <Checkbox
                checked={acceptedCoC}
                onChange={(event) => setAcceptedCoC(event.currentTarget.checked)}
                label="I have read and agree to the Creator Program Code of Conduct."
                size="sm"
              />
            </Stack>
          </ScrollArea.Autosize>
          <Group ml="auto">
            <Button onClick={handleClose} color="gray" disabled={updateUserSettings.isLoading}>
              Go back
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!acceptedCoC}
              loading={updateUserSettings.isLoading}
            >
              Accept
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

export function OwnedBuzzWithdrawalRequestsPaged() {
  const { classes } = useBuzzDashboardStyles();
  const [filters, setFilters] = useState<
    Omit<GetPaginatedOwnedBuzzWithdrawalRequestSchema, 'limit'>
  >({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { data: settings, isLoading: isLoadingSettings } = trpc.user.getSettings.useQuery();

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
          message: 'Withdrawal request has been canceled successfully and buzz has been refunded.',
        });
      },
    });
  };

  return (
    <Paper withBorder p="lg" radius="md" className={classes.tileCard} id="buzz-withdrawals">
      <Stack spacing="sm">
        <Group position="apart">
          <Title order={2}>Withdrawal Requests</Title>
          <Button
            onClick={() => {
              if (!settings?.creatorsProgramCodeOfConductAccepted) {
                dialogStore.trigger({
                  component: AcceptCodeOfConduct,
                  props: {
                    onAccepted: () => {
                      dialogStore.trigger({
                        component: CreateWithdrawalRequest,
                      });
                    },
                  },
                });

                return;
              }

              dialogStore.trigger({
                component: CreateWithdrawalRequest,
              });
            }}
            disabled={isLoadingSettings}
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
                        <Stack spacing={0}>
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
      </Stack>
    </Paper>
  );
}
