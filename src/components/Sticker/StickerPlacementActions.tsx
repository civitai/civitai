import { Button, Group, Popover, Skeleton, Stack, Text } from '@mantine/core';
import { IconMessage } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Approve or decline placements, wherever the owner happens to be looking.
 *
 * One component for the image and the queue, so the two cannot end up asking
 * different questions before taking someone's money.
 *
 * **Decline confirms; approve confirms only when there is a note.** Declining
 * keeps 30% of what the placer paid and cannot be undone. A plain approve takes
 * nothing from the placer they did not choose to spend, so it goes straight
 * through — but an approve that would publish someone's words is a second
 * decision, and it is the one the owner cannot see the subject of otherwise.
 */
export function StickerPlacementActions({
  placementIds,
  compact = false,
  hasComment = false,
  stacked = false,
  onDone,
}: {
  placementIds: number[];
  compact?: boolean;
  /**
   * Whether this carries a note. Only meaningful for a single placement — a bulk
   * action deliberately does not offer the choice, so a mixed selection cannot
   * silently apply one answer to all of them.
   */
  hasComment?: boolean;
  /**
   * Stack the buttons instead of sitting them in a row. The queue gives each row
   * a narrow column; the overlay floats over artwork where a tall stack would
   * cover more of the image than a wide one.
   */
  stacked?: boolean;
  onDone?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const utils = trpc.useUtils();

  const act = trpc.placement.actOnStickers.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        // Deliberately does not promise a retry. Nothing retries a failed owner
        // action; the placement stays pending and reaches expiry, which refunds
        // the placer and pays the owner nothing — the opposite of what they just
        // chose. Saying "try again" is the only honest instruction.
        message: result.failed.length
          ? `Actioned ${result.settled}. ${result.failed.length} didn't go through — try those again.`
          : `Actioned ${result.settled}.`,
      });
      await utils.placement.invalidate();
      setConfirming(false);
      setApproving(false);
      onDone?.();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) }),
  });

  const size = compact ? 'compact-xs' : 'compact-sm';
  const disabled = !placementIds.length || act.isPending;
  // A bulk action never asks about notes, so the question can only be about one
  // placement — which is also the only case where the note can be shown.
  const asksAboutNote = hasComment && placementIds.length === 1;

  const approve = (hideComment?: boolean) =>
    act.mutate({
      placementIds,
      action: 'approve',
      ...(hideComment === undefined ? {} : { hideComment }),
    });

  const approveButton = (
    <Button
      size={size}
      color="green"
      disabled={disabled}
      fullWidth={stacked}
      onClick={() => (asksAboutNote ? setApproving((open) => !open) : approve())}
    >
      Approve{placementIds.length > 1 ? ` ${placementIds.length}` : ''}
    </Button>
  );

  return (
    <Group gap={4} wrap="nowrap" className={clsx(stacked && 'flex-col items-stretch')}>
      {asksAboutNote ? (
        <Popover opened={approving} onChange={setApproving} withArrow position="top" width={280}>
          <Popover.Target>{approveButton}</Popover.Target>
          {/* Unpadded so the header's divider can run the full width of the
              panel. Same reason, and the same shape, as the sticker hover
              card's dropdown. */}
          <Popover.Dropdown p={0}>
            <NoteDecision
              placementId={placementIds[0]}
              pending={act.isPending}
              onInclude={() => approve(false)}
              onOmit={() => approve(true)}
            />
          </Popover.Dropdown>
        </Popover>
      ) : (
        approveButton
      )}

      <Popover opened={confirming} onChange={setConfirming} withArrow position="top" width={260}>
        <Popover.Target>
          <Button
            size={size}
            color="red"
            fullWidth={stacked}
            // Filled, not light. `light` is a tinted background at low contrast,
            // which sits on top of arbitrary artwork on the image overlay and
            // becomes unreadable against anything busy or red.
            disabled={disabled}
            onClick={() => setConfirming((open) => !open)}
          >
            Decline
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            <Text size="xs">
              {placementIds.length > 1
                ? `Decline ${placementIds.length} placements?`
                : 'Decline this placement?'}{' '}
              The placer keeps most of what they paid, and a fee stays with you. This can&apos;t be
              undone.
            </Text>
            <Group gap="xs" justify="end">
              <Button size="compact-xs" variant="default" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                size="compact-xs"
                color="red"
                loading={act.isPending}
                onClick={() => act.mutate({ placementIds, action: 'decline' })}
              >
                Decline
              </Button>
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

/**
 * The note, and the two ways to accept the sticker carrying it.
 *
 * The text is shown here because this is the only place the decision is made
 * with the words in front of you — on the image there is no indication a note
 * exists at all until the sticker is already live. Fetched on open rather than
 * carried by the listing, which runs for every image on a feed page.
 *
 * Closing the popover is the third answer and needs no button: it leaves the
 * placement pending, so Decline is still available.
 */
function NoteDecision({
  placementId,
  pending,
  onInclude,
  onOmit,
}: {
  placementId: number;
  pending: boolean;
  onInclude: () => void;
  onOmit: () => void;
}) {
  const { data, isLoading } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { staleTime: 60_000 }
  );

  return (
    <>
      {/* A panel header, divider across the full width, styled like the sticker
          hover card's — the two are the same kind of object seen from two
          places, and matching them is what stops the sticker UI reading as
          several unrelated widgets. */}
      <Group
        gap={6}
        px="sm"
        py={6}
        wrap="nowrap"
        className="border-b border-gray-3 dark:border-dark-4"
      >
        <IconMessage size={14} className="shrink-0 text-yellow-6" />
        <Text size="xs" c="dimmed" className="min-w-0 truncate">
          They left a note with this sticker
        </Text>
      </Group>

      <Stack gap="xs" p="sm">
        {/* Its own surface rather than a rule beside it. The note is the subject
            of the question and everything else in the panel is instructions
            about it, so it has to read as quoted content at a glance. */}
        {isLoading ? (
          <Skeleton height={40} radius="sm" />
        ) : (
          <div className="rounded-md bg-gray-2 px-2 py-1.5 dark:bg-dark-5">
            <Text size="sm" className="whitespace-pre-wrap break-words">
              {data?.comment ?? 'The note is no longer available.'}
            </Text>
          </div>
        )}

        <Stack gap={4}>
          <Button size="compact-xs" color="green" loading={pending} onClick={onInclude}>
            Approve with the note
          </Button>
          <Button size="compact-xs" variant="default" loading={pending} onClick={onOmit}>
            Approve without it
          </Button>
        </Stack>

        {/* Under the buttons, not above them. It explains what the second button
            does, and between the note and the choice it pushed the note far
            enough from the buttons to be skipped. */}
        <Text size="xs" c="dimmed">
          Approving without it keeps the sticker and leaves the note private — only you, the person
          who placed it, and moderators can read it.
        </Text>
      </Stack>
    </>
  );
}
