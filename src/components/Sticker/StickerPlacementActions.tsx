import { Button, Group, Popover, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Approve or decline placements, wherever the owner happens to be looking.
 *
 * One component for the image and the queue, so the two cannot end up asking
 * different questions before taking someone's money.
 *
 * **Decline confirms; approve does not.** Approving is reversible — the owner
 * can remove an approved placement afterwards and it refunds in full. Declining
 * keeps 30% of what the placer paid and cannot be undone, so it gets the extra
 * press. That asymmetry is the point rather than an inconsistency.
 */
export function StickerPlacementActions({
  placementIds,
  compact = false,
  onDone,
}: {
  placementIds: number[];
  compact?: boolean;
  onDone?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
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
      onDone?.();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) }),
  });

  const size = compact ? 'compact-xs' : 'compact-sm';
  const disabled = !placementIds.length || act.isPending;

  return (
    <Group gap={4} wrap="nowrap">
      <Button
        size={size}
        color="green"
        disabled={disabled}
        onClick={() => act.mutate({ placementIds, action: 'approve' })}
      >
        Approve{placementIds.length > 1 ? ` ${placementIds.length}` : ''}
      </Button>

      <Popover opened={confirming} onChange={setConfirming} withArrow position="top" width={260}>
        <Popover.Target>
          <Button
            size={size}
            color="red"
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
