import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { dealActionLabel, dealButtons } from '~/components/CreatorShop/Services/deals/deal-ui';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useServiceDealMutations } from '~/components/CreatorShop/Services/deals/deal.util';
import { DealTextActionModal } from '~/components/CreatorShop/Services/deals/DealTextActionModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function DealActionsPanel({ deal }: { deal: ServiceDealView }) {
  const features = useFeatureFlags();
  const mutations = useServiceDealMutations(deal.id);
  const buttons = dealButtons(deal, { servicesEnabled: !!features.creatorServices });
  if (buttons.length === 0) return null;

  const id = deal.id;
  const confirm = (title: string, body: string, onConfirm: () => void, danger = false) =>
    openConfirmModal({
      title,
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: title, cancel: 'Back' },
      confirmProps: danger ? { color: 'red' } : undefined,
      onConfirm,
    });

  const run: Record<string, () => void> = {
    accept: () =>
      confirm(
        'Accept request',
        `You commit to delivering within ${deal.deliveryDays} days. The Buzz stays in escrow until the buyer accepts your delivery.`,
        () => mutations.accept.mutate({ id })
      ),
    withdraw: () =>
      confirm(
        'Withdraw request',
        'The request is cancelled and the Buzz held for it goes back to you.',
        () => mutations.withdraw.mutate({ id }),
        true
      ),
    cancelLate: () =>
      confirm(
        'Cancel (overdue)',
        'The seller is past the due date. Cancelling closes the deal and returns your Buzz.',
        () => mutations.cancelLate.mutate({ id }),
        true
      ),
    decline: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Decline request',
          description: 'The buyer gets their Buzz back.',
          maxLength: 1000,
          choices: [{ label: 'Decline', color: 'red', value: 'decline' }],
          onSubmit: (_: string, reason?: string) => mutations.decline.mutateAsync({ id, reason }),
        },
      }),
    requestCancellation: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Request cancellation',
          description:
            'The other side can agree or refuse. If they do not answer in time, the cancellation goes through and the buyer is refunded.',
          required: true,
          maxLength: 1000,
          choices: [{ label: 'Send request', color: 'red', value: 'send' }],
          onSubmit: (_: string, reason?: string) =>
            mutations.requestCancellation.mutateAsync({ id, reason: reason ?? '' }),
        },
      }),
    respondCancellation: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Respond to cancellation',
          description: deal.cancellation?.reason
            ? `Their reason: "${deal.cancellation.reason}"`
            : undefined,
          maxLength: 1000,
          choices: [
            { label: 'Keep the deal', value: 'refuse' },
            { label: 'Agree to cancel', color: 'red', value: 'agree' },
          ],
          onSubmit: (value: string, comment?: string) =>
            mutations.respondCancellation.mutateAsync({ id, agree: value === 'agree', comment }),
        },
      }),
  };

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Text fw={600}>Your move</Text>
        <Group gap="sm">
          {buttons.map(({ action, primary }) => (
            <Button
              key={action}
              color={primary ? 'yellow' : 'gray'}
              variant={primary ? 'filled' : 'light'}
              onClick={run[action]}
            >
              {dealActionLabel[action]}
            </Button>
          ))}
        </Group>
      </Stack>
    </Paper>
  );
}
