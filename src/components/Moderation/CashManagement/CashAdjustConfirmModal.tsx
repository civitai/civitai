import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { centsToDollars, dollars } from '~/components/Moderation/CashManagement/cash-format';
import type {
  CashAccountType,
  CashAdjustmentDirection,
} from '~/components/Moderation/CashManagement/cash-format';

export type PendingCashAdjustment = {
  userId: number;
  username: string;
  accountType: CashAccountType;
  direction: CashAdjustmentDirection;
  amount: number;
  note: string;
  currentBalance: number;
};

type Props = {
  adjustment: PendingCashAdjustment | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: (adjustment: PendingCashAdjustment) => void;
};

export function CashAdjustConfirmModal({ adjustment, loading, onClose, onConfirm }: Props) {
  return (
    <Modal opened={!!adjustment} onClose={onClose} title="Confirm Cash Adjustment">
      {adjustment && (
        <ConfirmBody
          key={`${adjustment.userId}-${adjustment.direction}-${adjustment.amount}`}
          adjustment={adjustment}
          loading={loading}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

function ConfirmBody({
  adjustment,
  loading,
  onClose,
  onConfirm,
}: Omit<Props, 'adjustment'> & { adjustment: PendingCashAdjustment }) {
  const [typed, setTyped] = useState('');
  const { userId, username, accountType, direction, amount, note, currentBalance } = adjustment;
  const isGrant = direction === 'grant';
  const balanceAfter = currentBalance + (isGrant ? amount : -amount);
  const accountLabel = accountType === 'cashPending' ? 'Cash Pending' : 'Cash Settled';
  const matches = typed.trim().toLowerCase() === username.toLowerCase();

  return (
    <Stack gap="md">
      <Text>
        You are about to <strong>{direction}</strong> <strong>${centsToDollars(amount)}</strong> (
        {amount} cents) {isGrant ? 'to' : 'from'} <strong>@{username}</strong> (user {userId})
        &apos;s <strong>{accountLabel}</strong> account.
      </Text>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <Text size="xs" c="dimmed">
            {accountLabel} now
          </Text>
          <Text fw={600} data-testid="balance-now">
            {dollars(currentBalance)}
          </Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">
            {accountLabel} after
          </Text>
          <Text fw={600} data-testid="balance-after">
            {dollars(balanceAfter)}
          </Text>
        </div>
      </div>
      {balanceAfter < 0 && (
        <Alert color="red" p="xs">
          This deduction is larger than the current {accountLabel} balance.
        </Alert>
      )}
      <Text size="sm" c="dimmed">
        Reason: {note}
      </Text>
      <TextInput
        label={`Type the username (${username}) to confirm`}
        value={typed}
        onChange={(e) => setTyped(e.currentTarget.value)}
        autoComplete="off"
        data-autofocus
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          color={isGrant ? 'green' : 'red'}
          disabled={!matches}
          loading={loading}
          onClick={() => onConfirm(adjustment)}
        >
          Confirm {isGrant ? 'Grant' : 'Deduction'}
        </Button>
      </Group>
    </Stack>
  );
}
