import { useState } from 'react';
import { Button, Group, Modal, NumberInput, Select, Stack, Switch, Text } from '@mantine/core';
import type { BuzzLimit, SimpleBuzzLimit } from '~/server/schema/api-key.schema';
import { budgetsToSimpleBuzzLimit, simpleBuzzLimitToBudgets } from '~/server/schema/api-key.schema';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

const periodOptions = [
  { value: 'day', label: 'Per 24 hours' },
  { value: 'week', label: 'Per 7 days' },
  { value: 'month', label: 'Per 30 days' },
];

type Subject = { type: 'apiKey'; id: number } | { type: 'oauth'; clientId: string };

type Props = {
  opened: boolean;
  onClose: () => void;
  subject: Subject;
  name: string;
  initialLimit: BuzzLimit | null;
};

/**
 * Generic spend-limit editor for both User-type API keys and OAuth-issued
 * grants. The simple UI exposes a single sliding budget (limit + period); we
 * map to the canonical `BuzzLimit` (BuzzBudget[]) on save and back on load.
 * If the stored buzzLimit can't be expressed as a simple sliding budget (for
 * example a power user set up multiple budgets via the API), the modal
 * defaults the form fields to "no limit" and a warning could be added later.
 */
export function EditBuzzLimitModal({ opened, onClose, subject, name, initialLimit }: Props) {
  const utils = trpc.useUtils();
  const initialSimple: SimpleBuzzLimit | null = budgetsToSimpleBuzzLimit(initialLimit);
  const [enabled, setEnabled] = useState(!!initialSimple);
  const [amount, setAmount] = useState<number | ''>(initialSimple?.limit ?? 5000);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(initialSimple?.period ?? 'day');

  const apiKeyMutation = trpc.apiKey.setBuzzLimit.useMutation({
    onSuccess() {
      utils.apiKey.getAllUserKeys.invalidate();
      utils.apiKey.getSpend.invalidate();
      onClose();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update limit',
        error: new Error(error.message),
      });
    },
  });

  const consentMutation = trpc.oauthConsent.setBuzzLimit.useMutation({
    onSuccess() {
      utils.oauthConsent.getConnectedApps.invalidate();
      utils.apiKey.getSpend.invalidate();
      onClose();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update limit',
        error: new Error(error.message),
      });
    },
  });

  const isLoading = apiKeyMutation.isPending || consentMutation.isPending;

  const handleSave = () => {
    const simple: SimpleBuzzLimit | null =
      enabled && typeof amount === 'number' && amount > 0 ? { limit: amount, period } : null;
    const buzzLimit = simpleBuzzLimitToBudgets(simple);

    if (subject.type === 'apiKey') {
      apiKeyMutation.mutate({ id: subject.id, buzzLimit });
    } else {
      consentMutation.mutate({ clientId: subject.clientId, buzzLimit });
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Spend limit — ${name}`}
      size="md"
      closeOnClickOutside={!isLoading}
      closeOnEscape={!isLoading}
    >
      <Stack>
        <Group justify="space-between" align="center">
          <Text size="sm" fw={500}>
            Limit enabled
          </Text>
          <Switch
            size="sm"
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
        </Group>
        <Text size="xs" c="dimmed">
          Caps how much buzz this {subject.type === 'apiKey' ? 'key' : 'app'} can spend on AI
          services (generation, training, scanning) in a rolling window. Changes apply on the next
          request.
        </Text>
        {enabled && (
          <Group grow>
            <NumberInput
              label="Limit"
              placeholder="Amount in buzz"
              min={1}
              value={amount}
              onChange={(v) => setAmount(typeof v === 'number' ? v : '')}
              thousandSeparator=","
            />
            <Select
              label="Window"
              data={periodOptions}
              value={period}
              onChange={(v) => v && setPeriod(v as 'day' | 'week' | 'month')}
              allowDeselect={false}
            />
          </Group>
        )}
        <Group justify="space-between">
          <Button variant="default" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={isLoading}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
