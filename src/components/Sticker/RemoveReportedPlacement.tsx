import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconEye, IconEyeOff, IconTrash } from '@tabler/icons-react';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import { moderatorTakedownConsequence } from '~/components/Sticker/payout-copy';
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
  const utils = trpc.useUtils();

  const { data: placement, isLoading } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { retry: false }
  );

  // The proportionate answer to a note report, and it is a moderator's to give:
  // `setStickerCommentHidden` takes `isModerator` and waives the owner check.
  // Without it the only button here removes a sticker whose artwork nobody
  // complained about — and on a pending one, forfeits what the placer paid.
  const setHidden = trpc.placement.setStickerCommentHidden.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({ message: result.hidden ? 'Note hidden.' : 'Note restored.' });
      return utils.placement.getStickerPlacementDetail.invalidate({ placementId });
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't change the note", error: new Error(error.message) }),
  });

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
          {/* Both branches were false on a free row: there is no escrow to
              forfeit and no payment the creator already received. The suspension
              pointer is worth keeping in the paid wording, so the two are
              separate sentences rather than one with a clause swapped. */}
          <Text size="sm" c="dimmed">
            {placement.free
              ? moderatorTakedownConsequence({
                  pending: placement.status === 'pending',
                  free: true,
                })
              : placement.status === 'pending'
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
      {!!placement.comment && (
        // Shown whenever there is a note, not only when the reporter said the
        // note was the problem. The service hands moderators the text even when
        // the owner has hidden it, for exactly this — and the two reports on one
        // placement do not dedupe, so the sticker-target one often arrives
        // first, from someone who classified it differently to what a moderator
        // finds when they look. `target` says what was reported; it does not
        // decide which remedies exist.
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {target === 'comment' ? 'Reported: the note attached to this sticker' : 'Its note'}
            {placement.commentHidden ? ' (already hidden)' : ''}
          </Text>
          <div className="rounded-md bg-gray-2 px-2 py-1.5 dark:bg-dark-5">
            <Text size="sm" className="whitespace-pre-wrap break-words">
              {placement.comment}
            </Text>
          </div>
          <Group gap="xs" justify="space-between">
            <Text size="xs" c="dimmed">
              Hiding leaves the sticker up and is reversible, and the owner can put it back.
              Removing takes the whole sticker off.
            </Text>
            <Button
              variant="default"
              size="compact-sm"
              leftSection={
                placement.commentHidden ? <IconEye size={14} /> : <IconEyeOff size={14} />
              }
              loading={setHidden.isPending}
              onClick={() => setHidden.mutate({ placementId, hidden: !placement.commentHidden })}
            >
              {placement.commentHidden ? 'Restore note' : 'Hide note'}
            </Button>
          </Group>
        </Stack>
      )}
      {!placement.comment && target === 'comment' && (
        // The report says the note is the problem and there is no note. Nothing
        // cross-checks the two at submit, and a note cannot be edited away, so
        // this is a forged or mistaken classification rather than a race — and
        // the moderator should see that rather than an empty panel.
        <Text size="xs" c="dimmed">
          This report names a note, but the sticker has none.
        </Text>
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
