import { Button } from '@mantine/core';
import { IconCloudDownload } from '@tabler/icons-react';
import { openAddFromImportsModal } from '~/components/Dialog/triggers/add-from-hugging-face-imports';
import { useFilesContext } from '~/components/Resource/FilesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * 🔴 Through the dialog store, not an inline `<Modal>`: Manage files is a store dialog (z-index
 * 300+), and a plain Modal renders at Mantine's default 200 — behind it.
 */
export function AddFromImportsButton({ modelVersionId }: { modelVersionId: number }) {
  const currentUser = useCurrentUser();
  const { adoptFiles, modelType } = useFilesContext();
  if (!currentUser?.isModerator) return null;

  return (
    <Button
      size="compact-sm"
      variant="light"
      leftSection={<IconCloudDownload size={14} />}
      onClick={() => openAddFromImportsModal({ modelVersionId, modelType, adoptFiles })}
    >
      Add from Hugging Face imports
    </Button>
  );
}
