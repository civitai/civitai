import { Button, Group, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { closeAllModals, openModal } from '@mantine/modals';
import { IconShieldX } from '@tabler/icons-react';
import { useState } from 'react';
import {
  CRUCIBLE_TAKEDOWN_CREATOR_FUNDS,
  CRUCIBLE_TAKEDOWN_REASON_LENGTH,
} from '~/shared/constants/crucible.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

function useTakeDown(crucibleId: number) {
  const utils = trpc.useUtils();
  return trpc.crucible.takeDown.useMutation({
    onSuccess: (result) => {
      if (result.failedRefunds.length)
        showErrorNotification({
          title: 'Taken down, but some refunds did not go through',
          error: new Error(
            `${result.failedRefunds.length} refund(s) still owed — take it down again to retry.`
          ),
        });
      else
        showSuccessNotification({
          title: 'Crucible taken down',
          message: `${result.refundedEntries} entries refunded. Creator funds: ${result.creatorFunds}.`,
        });
      closeAllModals();
      utils.crucible.getById.invalidate({ id: crucibleId });
      utils.crucible.getEntries.invalidate({ crucibleId });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not take down', error: new Error(error.message) }),
  });
}

function TakeDownForm({ crucibleId }: { crucibleId: number }) {
  const [reason, setReason] = useState('');
  const takeDown = useTakeDown(crucibleId);
  const trimmed = reason.trim();
  const valid =
    trimmed.length >= CRUCIBLE_TAKEDOWN_REASON_LENGTH.min &&
    trimmed.length <= CRUCIBLE_TAKEDOWN_REASON_LENGTH.max;

  return (
    <Stack gap="sm">
      <Text size="sm">
        The page is removed for everyone but moderators. The creator is told the reason below;
        entrants are told it was removed and get their entry fees back. Nothing is deleted.
      </Text>
      <Textarea
        label="Reason (sent to the creator)"
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        minRows={3}
        autosize
        maxLength={CRUCIBLE_TAKEDOWN_REASON_LENGTH.max}
        required
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => closeAllModals()}>
          Keep it
        </Button>
        <Button
          color="red"
          disabled={!valid}
          loading={takeDown.isPending}
          onClick={() => takeDown.mutate({ id: crucibleId, reason: trimmed })}
        >
          Take Down
        </Button>
      </Group>
    </Stack>
  );
}

/** Moderators only. */
export function CrucibleTakeDownPanel({
  crucibleId,
  canTakeDown,
  hasRefunds,
  takenDownAt,
  takedownReason,
}: {
  crucibleId: number;
  canTakeDown: boolean;
  /** A Completed crucible is hidden only: there is nothing to retry or release. */
  hasRefunds: boolean;
  takenDownAt: Date | null;
  takedownReason: string | null;
}) {
  const rerun = useTakeDown(crucibleId);
  if (!takenDownAt && !canTakeDown) return null;

  return (
    <Paper className="rounded-lg p-6" bg="dark.6">
      <Title order={5} className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white">
        <IconShieldX size={16} />
        Takedown
      </Title>
      {takenDownAt ? (
        <Stack gap="sm">
          <Text size="sm">
            Taken down {formatDate(takenDownAt)}. Reason: {takedownReason}
          </Text>
          {hasRefunds && (
            <Button
              variant="light"
              fullWidth
              loading={rerun.isPending}
              onClick={() => rerun.mutate({ id: crucibleId, reason: takedownReason ?? '' })}
            >
              Retry refunds
            </Button>
          )}
          {hasRefunds && CRUCIBLE_TAKEDOWN_CREATOR_FUNDS === 'hold' && (
            <Button
              variant="outline"
              fullWidth
              loading={rerun.isPending}
              onClick={() =>
                rerun.mutate({
                  id: crucibleId,
                  reason: takedownReason ?? '',
                  releaseCreatorFunds: true,
                })
              }
            >
              Release creator funds
            </Button>
          )}
        </Stack>
      ) : (
        <Button
          color="red"
          variant="outline"
          fullWidth
          leftSection={<IconShieldX size={16} />}
          onClick={() =>
            openModal({
              title: 'Take down crucible',
              centered: true,
              children: <TakeDownForm crucibleId={crucibleId} />,
            })
          }
        >
          Take Down Crucible
        </Button>
      )}
    </Paper>
  );
}
