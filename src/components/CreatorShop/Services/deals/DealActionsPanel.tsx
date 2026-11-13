import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  cancellationCodeOptions,
  cancellationReasonLine,
  cancellationSide,
  dealActionLabel,
  dealButtons,
  declineCodeOptions,
  disputeCodeOptions,
  exitInputs,
} from '~/components/CreatorShop/Services/deals/deal-ui';

import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useServiceDealMutations } from '~/components/CreatorShop/Services/deals/deal.util';
import { DealTextActionModal } from '~/components/CreatorShop/Services/deals/DealTextActionModal';
import { acceptDeliveryBlocked } from '~/components/CreatorShop/Services/deals/deal-files';
import { useServiceDealFiles } from '~/components/CreatorShop/Services/deals/DealFilesPanel';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { pluralize } from '~/shared/utils/pluralize';
import type { DealAction } from '~/shared/utils/creator-service-deal-view';
import { SERVICE_DEAL_DISPUTE_WINDOW_MS } from '~/shared/constants/creator-services.constants';

const DISPUTE_WINDOW_HOURS = SERVICE_DEAL_DISPUTE_WINDOW_MS / 3_600_000;

export function DealActionsPanel({ deal }: { deal: ServiceDealView }) {
  const features = useFeatureFlags();
  const mutations = useServiceDealMutations(deal.id);
  const { data: files, isError } = useServiceDealFiles(deal);
  // Shown but disabled, with the reason, so the buyer knows it is coming rather than missing.
  const acceptBlocked = acceptDeliveryBlocked(deal, { files, failed: isError });
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

  const revisionsLeft = deal.revisionsIncluded - deal.revisionsUsed;

  // Every action, so a new one fails to compile here rather than render a dead button.
  const run: Record<DealAction, () => void> = {
    acceptDelivery: () =>
      confirm(
        'Accept delivery',
        `This completes the deal and unlocks the final files. You then have ${DISPUTE_WINDOW_HOURS} hours to report a problem; after that the Buzz is paid to the seller.`,
        () => mutations.acceptDelivery.mutate({ id })
      ),
    requestRevision: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Request a revision',
          description: `Tell the seller what to change. This uses 1 of your ${revisionsLeft} remaining ${
            revisionsLeft === 1 ? 'revision' : 'revisions'
          }.`,
          required: true,
          label: 'What should change',
          maxLength: 2000,
          choices: [{ label: 'Send revision request', value: 'send' }],
          onSubmit: (_: string, comment?: string) =>
            mutations.requestRevision.mutateAsync({ id, comment: comment ?? '' }),
        },
      }),
    openDispute: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Report a problem',
          description:
            'Use this if the final files are missing, broken or not what the preview showed. The Buzz stays held and our moderators review the deal, then decide whether it goes to the seller or back to you.',
          required: true,
          maxLength: 2000,
          codes: disputeCodeOptions,
          muted: deal.viewerMuted,
          choices: [{ label: 'Report to moderators', color: 'red', value: 'send' }],
          onSubmit: (_: string, reason?: string, code?: string) =>
            mutations.openDispute.mutateAsync(exitInputs.openDispute(id, reason, code)),
        },
      }),
    accept: () =>
      confirm(
        'Accept request',
        `You commit to delivering within ${pluralize(
          deal.deliveryDays,
          'day'
        )}. The Buzz stays in escrow until the buyer accepts your delivery.`,
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
          codes: declineCodeOptions,
          muted: deal.viewerMuted,
          choices: [{ label: 'Decline', color: 'red', value: 'decline' }],
          onSubmit: (_: string, reason?: string, code?: string) =>
            mutations.decline.mutateAsync(exitInputs.decline(id, reason, code)),
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
          codes: cancellationCodeOptions(cancellationSide(deal.viewerRole)),
          muted: deal.viewerMuted,
          choices: [{ label: 'Send request', color: 'red', value: 'send' }],
          onSubmit: (_: string, reason?: string, code?: string) =>
            mutations.requestCancellation.mutateAsync(
              exitInputs.requestCancellation(id, reason, code)
            ),
        },
      }),
    respondCancellation: () =>
      dialogStore.trigger({
        component: DealTextActionModal,
        props: {
          title: 'Respond to cancellation',
          description: cancellationReasonLine(deal),
          maxLength: 1000,
          muted: deal.viewerMuted,
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
              disabled={action === 'acceptDelivery' && !!acceptBlocked}
              onClick={run[action]}
            >
              {dealActionLabel[action]}
            </Button>
          ))}
        </Group>
        {acceptBlocked && buttons.some(({ action }) => action === 'acceptDelivery') && (
          <Text size="sm" c="dimmed">
            {acceptBlocked}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
