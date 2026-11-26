import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';
import { openFolderEditModal } from '~/components/Profile/Folders/folder-dialogs';
import type { FolderCardActions } from '~/components/Profile/Folders/FolderCard';
import type { FolderRowSchema } from '~/server/schema/profile-folders.schema';
import type { ProfileFolderRow } from '~/server/services/profile-folders.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** The owner's folder card menu: edit, hide or show on the profile, delete. */
export function useFolderCardActions({
  user,
  rows,
  storedRows,
}: {
  user: { id: number; username: string };
  rows: ProfileFolderRow[];
  storedRows: FolderRowSchema[] | null;
}): FolderCardActions {
  const utils = trpc.useUtils();
  const refresh = () => utils.profileFolders.getAll.invalidate({ userId: user.id });
  const setRows = trpc.profileFolders.setRows.useMutation({
    onSuccess: refresh,
    onError: (error) =>
      showErrorNotification({
        title: 'Could not update the folder',
        error: new Error(error.message),
      }),
  });
  const remove = trpc.collection.delete.useMutation({
    onSuccess: async () => {
      await refresh();
      showSuccessNotification({ message: 'Folder deleted' });
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not delete the folder',
        error: new Error(error.message),
      }),
  });

  return {
    onEdit: (folder) => openFolderEditModal({ folder, user }),
    onToggleHidden: (folder) => {
      // Rows as shown, with this folder flipped; an unplaced folder is placed where it shows.
      const next: FolderRowSchema[] = rows.map((row, i) => ({
        id: row.id ?? `top${i}`,
        name: row.name,
        folders: row.folders.map((f) => ({
          id: f.id,
          ...((f.id === folder.id ? !folder.hidden : f.hidden) ? { hidden: true } : {}),
        })),
      }));
      setRows.mutate({ rows: next, ...(storedRows ? { ifUnchangedFrom: storedRows } : {}) });
    },
    onDelete: (folder) =>
      openConfirm({
        title: `Delete ${folder.name}?`,
        message:
          'The folder goes away for good. What was in it stays on your account and anywhere else you put it.',
        labels: { cancel: 'Cancel', confirm: 'Delete folder' },
        confirmProps: { color: 'red' },
        onConfirm: () => remove.mutateAsync({ id: folder.id }),
      }),
  };
}
