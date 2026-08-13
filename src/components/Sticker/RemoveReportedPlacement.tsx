import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconTrash } from '@tabler/icons-react';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The moderator's action on a sticker report.
 *
 * The report has always carried which placement it is about; until now nothing
 * consumed it, so a moderator read the id out of the details dump and had no way
 * to act on it. The detail lookup here is what makes the action safe to press —
 * removal is not reversible, and an id alone does not tell you whose sticker you
 * are taking down.
 */
export function RemoveReportedPlacement({
  placementId,
  target = 'sticker',
}: {
  placementId: number;
  /**
   * Which half the report is about. A note report is answered by reading the
   * note, and this query is the only place a moderator can — the text is not on
   * the report row, and the feed listing strips it.
   */
  target?: 'sticker' | 'comment';
}) {
  const forget = useForgetStickerPlacement();

  const { data: placement, isLoading } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { retry: false }
  );

  const remove = trpc.placement.removePlacement.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        message: result.removed
          ? 'Placement removed.'
          : 'Nothing to remove — it had already been settled.',
      });
      await forget(placementId);
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't remove it", error: new Error(error.message) }),
  });

  if (isLoading) return null;

  // The detail query only returns live placements, so a miss means this one is
  // already gone — declined, expired, or removed by someone else.
  if (!placement)
    return (
      <Alert color="gray">
        <Text size="sm">This placement is no longer live. Nothing to remove.</Text>
      </Alert>
    );

  const confirm = () =>
    openConfirmModal({
      title: 'Remove this placement',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            {placement.sticker?.name ?? 'This sticker'}, placed by{' '}
            {placement.placer?.username ?? 'an unknown user'}, comes off the image for everyone.
          </Text>
          <Text size="sm" c="dimmed">
            {placement.status === 'pending'
              ? 'It never went live, so its escrow is forfeited rather than refunded.'
              : 'No Buzz moves: the creator was already paid for it, and clawing that back would punish the wrong person. Suspend the placer if the problem is them rather than this one sticker.'}
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ placementId }),
    });

  return (
    <Stack gap="xs">
      {target === 'comment' && (
        // The subject of the complaint, quoted where the action is taken. The
        // service hands moderators the text even when the owner has hidden it,
        // for exactly this: the alternative is answering a report about words
        // nobody in the queue can read.
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Reported: the note attached to this sticker
            {placement.commentHidden ? ' (the owner has already hidden it)' : ''}
          </Text>
          <div className="rounded-md bg-gray-2 px-2 py-1.5 dark:bg-dark-5">
            <Text size="sm" className="whitespace-pre-wrap break-words">
              {placement.comment ?? 'The note is no longer available.'}
            </Text>
          </div>
          <Text size="xs" c="dimmed">
            Removing takes the whole sticker off. Only the image owner can hide a note.
          </Text>
        </Stack>
      )}
      <Group justify="space-between">
        <Text size="sm">
          {placement.sticker?.name ?? `Placement ${placementId}`} &middot;{' '}
          {placement.placer?.username ?? 'unknown placer'}
        </Text>
        <Button
          color="red"
          size="compact-sm"
          leftSection={<IconTrash size={14} />}
          loading={remove.isPending}
          onClick={confirm}
        >
          Remove placement
        </Button>
      </Group>
    </Stack>
  );
}
