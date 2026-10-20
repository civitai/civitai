import { Button, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconUserCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Generation outputs expire and the profile picture only accepts our own storage, so the result is copied first. */
export function AvatarProfilePictureButton({
  output,
}: {
  output: { url: string; width?: number; height?: number };
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { uploadToCF } = useCFImageUpload();
  const updateUser = trpc.user.update.useMutation();
  const [saving, setSaving] = useState(false);

  if (!currentUser) return null;

  const save = async () => {
    setSaving(true);
    try {
      const file = await fetchBlobAsFile(output.url, 'avatar.png');
      if (!file) throw new Error('Could not load the image');
      const { id } = await uploadToCF(file);
      await updateUser.mutateAsync({
        id: currentUser.id,
        profilePicture: {
          url: id,
          width: output.width,
          height: output.height,
          mimeType: file.type,
          sizeKB: Math.ceil(file.size / 1024),
        },
      });
    } catch (error) {
      showErrorNotification({
        title: 'Could not update your profile picture',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    } finally {
      setSaving(false);
    }
    showSuccessNotification({ message: 'Your profile picture has been updated' });
    // The save has landed; a failed refresh only leaves the old picture showing until the next load.
    Promise.all([
      queryUtils.user.getById.invalidate({ id: currentUser.id }),
      queryUtils.userProfile.get.invalidate(),
      currentUser.refresh(),
    ]).catch(() => null);
  };

  return (
    <Button
      size="compact-sm"
      variant="light"
      color="gray"
      className="flex-1"
      loading={saving}
      leftSection={<IconUserCircle size={14} />}
      onClick={() =>
        openConfirmModal({
          title: 'Use as profile picture',
          children: <Text size="sm">This replaces your current profile picture.</Text>,
          centered: true,
          labels: { confirm: 'Use this image', cancel: 'Cancel' },
          onConfirm: save,
        })
      }
    >
      Use as profile picture
    </Button>
  );
}
