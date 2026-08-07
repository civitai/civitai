import { Checkbox, Menu, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconSticker, IconBan } from '@tabler/icons-react';
import { useRef } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Moderator control over a user's ability to place stickers, sitewide.
 *
 * Suspension is the answer to an abusive *placer*, as distinct from abusive
 * artwork — a fine sticker used maliciously is this; a sticker designed to abuse
 * is a cosmetic takedown. Creators handle individual cases by blocking, which is
 * instant and needs nobody.
 *
 * Bulk removal is offered here rather than as its own action because it is only
 * ever wanted alongside a suspension, and doing it without one leaves the placer
 * free to put everything back.
 */
export function SuspendPlacerMenuItem({ userId }: { userId: number }) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const removeExisting = useRef(false);

  const { data: suspended } = trpc.placement.isSuspended.useQuery(
    { userId },
    { enabled: !!features.stickerPlacement }
  );

  const onError = (error: { message: string }) =>
    showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) });

  const suspend = trpc.placement.suspendPlacer.useMutation({
    onSuccess: async (result) => {
      const removed = result.removed;
      showSuccessNotification({
        message: !removed
          ? 'Sticker placement suspended.'
          : [
              `Suspended. Removed ${removed.settled + removed.takenDown} placements.`,
              // Both of these were being dropped, which turned a partial sweep
              // into a clean success message.
              removed.failed.length ? `${removed.failed.length} could not be removed.` : '',
              removed.hasMore ? 'More remain — run it again.' : '',
            ]
              .filter(Boolean)
              .join(' '),
      });
      await utils.placement.invalidate();
    },
    onError,
  });

  const restore = trpc.placement.restorePlacer.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Sticker placement restored.' });
      await utils.placement.invalidate();
    },
    onError,
  });

  if (!features.stickerPlacement) return null;

  if (suspended)
    return (
      <Menu.Item
        leftSection={<IconSticker size={14} stroke={1.5} />}
        onClick={() => restore.mutate({ userId })}
      >
        Restore sticker placement
      </Menu.Item>
    );

  const confirm = () => {
    removeExisting.current = false;
    openConfirmModal({
      title: 'Suspend sticker placement',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            They will not be able to place stickers on anyone&apos;s work. Stickers in comments and
            DMs are unaffected.
          </Text>
          <Checkbox
            label="Also remove everything they have already placed"
            description="Pending placements forfeit their escrow; approved ones are taken down without clawing back what creators were already paid."
            onChange={(event) => (removeExisting.current = event.currentTarget.checked)}
          />
        </Stack>
      ),
      labels: { confirm: 'Suspend', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => suspend.mutate({ userId, removeExisting: removeExisting.current }),
    });
  };

  return (
    <Menu.Item
      color="red"
      leftSection={<IconBan size={14} stroke={1.5} />}
      onClick={confirm}
    >
      Suspend sticker placement
    </Menu.Item>
  );
}
