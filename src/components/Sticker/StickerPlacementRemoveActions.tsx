import { Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconShieldCancel, IconTrash } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import {
  moderatorTakedownConsequence,
  removalConsequence,
  removalLockReason,
} from '~/components/Sticker/payout-copy';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The two removal controls, in their own module so the hover card can load them
 * on demand.
 *
 * They are the only things in the card that reach `placement.util`, which pulls
 * the placement draft store and the free-offer helpers behind it — around 40 KB
 * of source that every surface rendering a sticker paid for statically,
 * including ones that never draw an interactive sticker at all. Both controls
 * are privileged too: one needs the space's owner, the other a moderator, so for
 * almost every viewer this code could never run.
 *
 * Split by consumer rather than by size. Deferring the whole card body would
 * have deferred the sticker artwork with it, because the artwork is the card's
 * own `children`.
 */
/**
 * The owner taking a sticker off their own image.
 *
 * Waits a week from approval, because approval already paid the owner and
 * nothing is refunded: without the wait an owner could take the Buzz and wipe
 * the sticker before anyone saw it. The refusal lives on the server — the
 * disabled control and its date are what the card *says*, not what decides it.
 *
 * Shares the header slot with the moderator's remove rather than sitting in a
 * footer of its own. A viewer has at most one of these powers, so the slot is
 * never ambiguous, and two remove buttons in two corners read as one control
 * duplicated.
 */
export function OwnerRemove({
  placementId,
  removableAt,
  free,
}: {
  placementId: number;
  removableAt: Date | string | null;
  /**
   * Whether this was placed against the creator's free capacity. Both sentences
   * below are about money, and both are false when none moved.
   */
  free: boolean;
}) {
  const forget = useForgetStickerPlacement();

  const remove = trpc.placement.actOnStickers.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Sticker removed.' });
      await forget(placementId);
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't remove it", error: new Error(error.message) }),
  });

  const locked = !!removableAt;

  return (
    <Tooltip
      withArrow
      multiline
      w={240}
      label={
        locked
          ? `${removalLockReason(free)} You can remove it from ${formatDate(removableAt as Date)}.`
          : 'Takes the sticker off your image. No Buzz moves.'
      }
    >
      {/* Wrapped, because a disabled control fires no pointer events and a
          tooltip on it never opens — which would leave the date explaining the
          button visible only to people who did not need it. */}
      <span className="shrink-0">
        <LegacyActionIcon
          color="red"
          variant="subtle"
          size="sm"
          aria-label="Remove this sticker from your image"
          disabled={locked}
          loading={remove.isPending}
          onClick={() =>
            openConfirmModal({
              title: 'Remove this sticker',
              children: <Text size="sm">{removalConsequence(free)}</Text>,
              labels: { confirm: 'Remove', cancel: 'Cancel' },
              confirmProps: { color: 'red' },
              onConfirm: () => remove.mutate({ placementIds: [placementId], action: 'remove' }),
            })
          }
        >
          <IconTrash size={14} />
        </LegacyActionIcon>
      </span>
    </Tooltip>
  );
}

/**
 * A moderator taking a sticker off the content it was placed on, from the
 * sticker itself.
 *
 * The report queue is the route for something a user complained about; this is
 * the route for a moderator who is looking at the image and can see the problem.
 * Same mutation either way, so the two cannot drift into different rules about
 * what removal means.
 *
 * On a live placement no money moves (Justin, 2026-08-08): the escrow was paid
 * to a content owner who did not choose the sticker, and clawing it back would
 * charge them for someone else's problem. **A pending PAID one is not that**: it
 * settles as `removeByModerator`, whose payout is a forfeit of the whole escrow,
 * fee and principal — so the confirmation has to say a different thing about the
 * money.

 *
 * A free row has no escrow at all, in either state, so both of those sentences are
 * false of one and the confirmation branches on `free` as well as on `pending`.
 *
 * Rendered for moderators only, which is convenience — `removePlacement` is a
 * `moderatorProcedure`, so the refusal is on the mutation and stays there.
 */
export function ModeratorRemove({
  placementId,
  pending = false,
  free,
}: {
  placementId: number;
  pending?: boolean;
  /** No escrow exists on a free row, so neither branch below is true of one. */
  free: boolean;
}) {
  const currentUser = useCurrentUser();
  const forget = useForgetStickerPlacement();

  const remove = trpc.placement.removePlacement.useMutation({
    onSuccess: async (result) => {
      // Reads the result rather than assuming it. The overlay can be drawing a
      // placement someone else already settled, and reporting success on a
      // takedown that removed nothing — beside a control that would have worked
      // — is how a moderator concludes the sticker is handled.
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

  if (!currentUser?.isModerator) return null;

  return (
    <Tooltip label="Take this sticker down as a moderator" withArrow>
      <LegacyActionIcon
        color="red"
        variant="subtle"
        size="sm"
        className="shrink-0"
        aria-label="Take down placement as moderator"
        loading={remove.isPending}
        onClick={() =>
          openConfirmModal({
            title: 'Take this placement down',
            children: <Text size="sm">{moderatorTakedownConsequence({ pending, free })}</Text>,
            labels: { confirm: 'Take down', cancel: 'Cancel' },
            confirmProps: { color: 'red' },
            onConfirm: () => remove.mutate({ placementId }),
          })
        }
      >
        {/* A shield, not a second bin. The owner's remove sits beside this one
            for an account holding both powers, and two identical icons would
            make the pair a coin toss over whose money moves. */}
        <IconShieldCancel size={14} />
      </LegacyActionIcon>
    </Tooltip>
  );
}
