import { IconPhotoOff } from '@tabler/icons-react';
import { openDialog } from '~/components/Dialog/openDialog';
import { Menu } from '~/components/MantineOverlays';
import {
  showErrorNotification,
  showSuccessNotification,
  showWarningNotification,
} from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The moderator's "Remove cover" on a song: removes only the song's own cover, with its own violation
 * type and owner notice, and leaves the song public with the placeholder. Hidden while the song has no
 * own cover; disabled while the cover is held for CSAM review, which the server refuses.
 */
export function RemoveSongCoverMenuItem({ songId }: { songId: number }) {
  const utils = trpc.useUtils();
  const { data: cover } = trpc.image.getSongCoverRemoval.useQuery({ id: songId });
  const { mutateAsync } = trpc.image.removeSongCover.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Could not remove the cover',
        error: new Error(error.message),
      });
    },
  });
  if (!cover) return null;

  const open = () =>
    openDialog(() => import('~/components/Dialog/Common/TosViolationDialog'), {
      title: 'Remove cover as TOS Violation',
      message:
        'Only the cover is removed: the song stays up with the placeholder. The uploader will be notified that their cover was removed.',
      onConfirm: async (violationType, violationDetails) => {
        const result = await mutateAsync({ id: songId, violationType, violationDetails });
        await utils.image.getSongCoverRemoval.invalidate({ id: songId });
        if (result.held)
          showWarningNotification({
            title: 'Not removed: sent for a second opinion',
            message:
              "This cover's appeal was approved, so a second moderator must confirm the removal on Re-removals in the moderator app.",
            autoClose: false,
          });
        else showSuccessNotification({ message: 'The cover was removed.' });
      },
    });

  return (
    <Menu.Item
      leftSection={<IconPhotoOff size={16} stroke={1.5} />}
      disabled={cover.held}
      onClick={open}
    >
      {cover.held ? 'Remove cover (held for review)' : 'Remove cover'}
    </Menu.Item>
  );
}
