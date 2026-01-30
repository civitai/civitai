import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
} from '@mantine/core';
import { useCallback, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type AccountType = 'cashPending' | 'cashSettled';
type Direction = 'grant' | 'deduct';

const refundableStatuses = new Set(['Paid', 'Scheduled', 'Submitted', 'InternalValue']);

function centsToDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export function CashManagementPage() {
  const queryUtils = trpc.useUtils();

  const [userId, setUserId] = useState<number | undefined>();
  const [accountType, setAccountType] = useState<AccountType>('cashSettled');
  const [direction, setDirection] = useState<Direction>('grant');
  const [amount, setAmount] = useState<number | undefined>();
  const [note, setNote] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refundTarget, setRefundTarget] = useState<{
    withdrawalId: string;
    amount: number;
  } | null>(null);
  const [refundNote, setRefundNote] = useState('');

  const validUserId = !!userId && userId > 0;

  const {
    data: cashData,
    isLoading: cashLoading,
    error: cashError,
  } = trpc.moderator.cash.getCashForUser.useQuery(
    { userId: userId! },
    { enabled: validUserId }
  );

  const { data: creatorData } = trpc.user.getCreator.useQuery(
    { id: userId! },
    { enabled: validUserId }
  );

  const {
    data: withdrawals,
    isLoading: withdrawalsLoading,
  } = trpc.moderator.cash.getWithdrawalHistory.useQuery(
    { userId: userId! },
    { enabled: validUserId }
  );

  const invalidateAll = useCallback(() => {
    if (!userId) return;
    queryUtils.moderator.cash.getCashForUser.invalidate({ userId });
    queryUtils.moderator.cash.getWithdrawalHistory.invalidate({ userId });
  }, [userId, queryUtils]);

  const adjustMutation = trpc.moderator.cash.adjustBalance.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Cash balance adjusted successfully' });
      invalidateAll();
      setAmount(undefined);
      setNote('');
      setConfirmOpen(false);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to adjust balance',
        error: new Error(error.message),
      });
      setConfirmOpen(false);
    },
  });

  const refundMutation = trpc.moderator.cash.updateWithdrawal.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Withdrawal refunded successfully' });
      invalidateAll();
      setRefundTarget(null);
      setRefundNote('');
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to refund withdrawal',
        error: new Error(error.message),
      });
    },
  });

  const handleSubmit = useCallback(() => {
    if (!userId || !amount || !note.trim()) return;
    adjustMutation.mutate({
      userId,
      amount,
      accountType,
      direction,
      note: note.trim(),
    });
  }, [userId, amount, accountType, direction, note, adjustMutation]);

  const handleRefund = useCallback(() => {
    if (!refundTarget) return;
    refundMutation.mutate({
      withdrawalId: refundTarget.withdrawalId,
      status: 'Rejected',
      note: refundNote.trim() || 'Mod refund',
    });
  }, [refundTarget, refundNote, refundMutation]);

  const canSubmit = validUserId && !!amount && amount > 0 && note.trim().length > 0;
  const dollarAmount = amount ? centsToDollars(amount) : '0.00';

  return (
    <div className="container mx-auto max-w-2xl py-4">
      <h1 className="mb-4 text-2xl font-bold">Cash Balance Management</h1>

      <Stack gap="md">
        {/* User Lookup */}
        <NumberInput
          label="User ID"
          placeholder="Enter user ID"
          min={1}
          value={userId ?? ''}
          onChange={(val) => setUserId(typeof val === 'number' ? val : undefined)}
        />

        {cashLoading && validUserId && <PageLoader />}

        {cashError && (
          <Alert color="red" title="Error">
            {cashError.message}
          </Alert>
        )}

        {/* User Info */}
        {creatorData && (
          <CreatorCardV2 user={creatorData} withActions={false} tipsEnabled={false} />
        )}

        {/* Cash Balances */}
        {cashData && (
          <Alert color="blue" title="Cash Balances">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <Text size="xs" c="dimmed">Pending</Text>
                <Text fw={600}>${centsToDollars(cashData.pending)}</Text>
                <Text size="xs" c="dimmed">{cashData.pending} cents</Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">Settled (Available)</Text>
                <Text fw={600}>${centsToDollars(cashData.ready)}</Text>
                <Text size="xs" c="dimmed">{cashData.ready} cents</Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">Withdrawn</Text>
                <Text fw={600}>${centsToDollars(cashData.withdrawn)}</Text>
                <Text size="xs" c="dimmed">{cashData.withdrawn} cents</Text>
              </div>
            </div>
          </Alert>
        )}

        {/* Adjustment Form */}
        {validUserId && (
          <>
            <Divider label="Manual Adjustment" labelPosition="center" />

            <Select
              label="Account Type"
              data={[
                { value: 'cashPending', label: 'Cash Pending' },
                { value: 'cashSettled', label: 'Cash Settled (Available to Withdraw)' },
              ]}
              value={accountType}
              onChange={(val) => setAccountType((val as AccountType) ?? 'cashSettled')}
            />

            <Select
              label="Direction"
              data={[
                { value: 'grant', label: 'Grant (add funds)' },
                { value: 'deduct', label: 'Deduct (remove funds)' },
              ]}
              value={direction}
              onChange={(val) => setDirection((val as Direction) ?? 'grant')}
            />

            <NumberInput
              label="Amount (in cents)"
              description={`= $${dollarAmount} USD`}
              placeholder="e.g. 1000 = $10.00"
              min={1}
              value={amount ?? ''}
              onChange={(val) => setAmount(typeof val === 'number' ? val : undefined)}
            />

            <Textarea
              label="Reason / Note"
              description="Required. Will be logged for audit purposes."
              placeholder="e.g. Refund for stuck Tipalti payment #12345"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              minRows={2}
            />

            <Button
              color={direction === 'grant' ? 'green' : 'red'}
              disabled={!canSubmit}
              onClick={() => setConfirmOpen(true)}
            >
              {direction === 'grant' ? 'Grant' : 'Deduct'} ${dollarAmount}{' '}
              {direction === 'grant' ? 'to' : 'from'}{' '}
              {accountType === 'cashPending' ? 'Pending' : 'Settled'}
            </Button>
          </>
        )}

        {/* Withdrawal History */}
        {validUserId && (
          <>
            <Divider label="Withdrawal History" labelPosition="center" />

            {withdrawalsLoading && <PageLoader />}

            {withdrawals && withdrawals.length === 0 && (
              <Text c="dimmed" ta="center">No withdrawal history.</Text>
            )}

            {withdrawals && withdrawals.length > 0 && (
              <Card withBorder p={0}>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Date</Table.Th>
                      <Table.Th>Amount</Table.Th>
                      <Table.Th>Fee</Table.Th>
                      <Table.Th>Method</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Note</Table.Th>
                      <Table.Th>Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {withdrawals.map((w) => (
                      <Table.Tr key={w.id}>
                        <Table.Td>{w.createdAt ? formatDate(w.createdAt) : '-'}</Table.Td>
                        <Table.Td>${centsToDollars(w.amount)}</Table.Td>
                        <Table.Td>${centsToDollars(w.fee)}</Table.Td>
                        <Table.Td>{w.method}</Table.Td>
                        <Table.Td>
                          <Badge
                            color={
                              w.status === 'Paid' ? 'green' :
                              w.status === 'Rejected' || w.status === 'Canceled' ? 'red' :
                              'yellow'
                            }
                            variant="light"
                          >
                            {w.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" lineClamp={2}>{w.note ?? '-'}</Text>
                        </Table.Td>
                        <Table.Td>
                          {refundableStatuses.has(w.status) && (
                            <Button
                              size="xs"
                              color="orange"
                              variant="light"
                              onClick={() => {
                                setRefundTarget({ withdrawalId: w.id, amount: w.amount });
                                setRefundNote('');
                              }}
                            >
                              Refund
                            </Button>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            )}
          </>
        )}
      </Stack>

      {/* Confirm Adjustment Modal */}
      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm Cash Adjustment"
      >
        <Stack gap="md">
          <Text>
            You are about to <strong>{direction}</strong>{' '}
            <strong>${dollarAmount}</strong> ({amount} cents){' '}
            {direction === 'grant' ? 'to' : 'from'} user <strong>{userId}</strong>&apos;s{' '}
            <strong>{accountType === 'cashPending' ? 'Cash Pending' : 'Cash Settled'}</strong>{' '}
            account.
          </Text>
          <Text size="sm" c="dimmed">
            Reason: {note}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              color={direction === 'grant' ? 'green' : 'red'}
              loading={adjustMutation.isLoading}
              onClick={handleSubmit}
            >
              Confirm {direction === 'grant' ? 'Grant' : 'Deduction'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Confirm Refund Modal */}
      <Modal
        opened={!!refundTarget}
        onClose={() => setRefundTarget(null)}
        title="Confirm Withdrawal Refund"
      >
        {refundTarget && (
          <Stack gap="md">
            <Text>
              Refund <strong>${centsToDollars(refundTarget.amount)}</strong> back to user{' '}
              <strong>{userId}</strong>&apos;s <strong>Cash Settled</strong> account?
            </Text>
            <Textarea
              label="Note (optional)"
              placeholder="e.g. Payment stuck in Tipalti, refunding to retry"
              value={refundNote}
              onChange={(e) => setRefundNote(e.currentTarget.value)}
              minRows={2}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setRefundTarget(null)}>
                Cancel
              </Button>
              <Button
                color="orange"
                loading={refundMutation.isLoading}
                onClick={handleRefund}
              >
                Confirm Refund
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

export default Page(CashManagementPage, {
  features: (features) => features.cashManagement,
});
