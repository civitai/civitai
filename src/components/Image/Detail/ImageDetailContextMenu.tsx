import { Menu, Loader } from '@mantine/core';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { CollectionType } from '@prisma/client';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { IconTrash, IconBan, IconLock, IconPencil } from '@tabler/icons-react';
import { ToggleLockComments } from '~/components/CommentsV2';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { DeleteImage } from '~/components/Image/DeleteImage/DeleteImage';
import { useRouter } from 'next/router';
import { NextLink } from '@mantine/next';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/*
TODO.gallery
  - we really need to implement stores for our key entities (model, review, image) that will allow us to update values without having to deal with the react-query cache. For an example, refer to the TosViolationButton component below.
*/

export function ImageDetailContextMenu({ children }: { children: React.ReactElement }) {
  const { image, isMod } = useImageDetailContext();
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const features = useFeatureFlags();

  const handleClose = () => {
    setLoading(false);
    setOpened(false);
  };
  const handleClick = (onClick: () => void) => {
    setLoading(true);
    onClick();
  };

  const handleDeleteSuccess = () => {
    handleClose();
    queryUtils.image.getInfinite.invalidate();
    queryUtils.image.getImagesAsPostsInfinite.invalidate();
    router.back();
  };

  const handleTosViolationSuccess = () => {
    handleClose();
    queryUtils.image.getInfinite.invalidate();
    queryUtils.image.getImagesAsPostsInfinite.invalidate();
    router.back();
  };

  if (!image) return null;

  return (
    <Menu opened={opened} onChange={setOpened} closeOnClickOutside={!loading}>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {image.postId && (
          <Menu.Item
            component={NextLink}
            icon={<IconPencil size={14} stroke={1.5} />}
            href={`/posts/${image.postId}/edit`}
          >
            Edit Image Post
          </Menu.Item>
        )}
        <DeleteImage imageId={image.id} onSuccess={handleDeleteSuccess}>
          {({ onClick, isLoading }) => (
            <Menu.Item
              color="red"
              icon={isLoading ? <Loader size={14} /> : <IconTrash size={14} stroke={1.5} />}
              onClick={() => handleClick(onClick)}
              disabled={isLoading}
              closeMenuOnClick={false}
            >
              Delete
            </Menu.Item>
          )}
        </DeleteImage>
        {features.collections && (
          <AddToCollectionMenuItem
            onClick={() =>
              openContext('addToCollection', { imageId: image.id, type: CollectionType.Image })
            }
          />
        )}
        {isMod && (
          <TosViolationButton onSuccess={handleTosViolationSuccess}>
            {({ onClick, isLoading }) => (
              <Menu.Item
                icon={isLoading ? <Loader size={14} /> : <IconBan size={14} stroke={1.5} />}
                onClick={() => handleClick(onClick)}
                disabled={isLoading}
                closeMenuOnClick={false}
              >
                Remove as TOS Violation
              </Menu.Item>
            )}
          </TosViolationButton>
        )}
        {isMod && image && (
          <ToggleLockComments entityId={image.id} entityType="image" onSuccess={handleClose}>
            {({ toggle, locked, isLoading }) => {
              return (
                <Menu.Item
                  icon={isLoading ? <Loader size={14} /> : <IconLock size={14} stroke={1.5} />}
                  onClick={() => handleClick(toggle)}
                  closeMenuOnClick={false}
                  disabled={isLoading}
                >
                  {locked ? 'Unlock' : 'Lock'} Comments
                </Menu.Item>
              );
            }}
          </ToggleLockComments>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

function TosViolationButton({ children, onSuccess }: ButtonCallbackProps) {
  const { image } = useImageDetailContext();

  const { mutate, isLoading } = trpc.image.setTosViolation.useMutation({
    async onSuccess() {
      closeModal('confirm-tos-violation');
      onSuccess?.();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not report review, please try again',
      });
    },
  });
  const handleTosViolation = () => {
    openConfirmModal({
      modalId: 'confirm-tos-violation',
      title: 'Report ToS Violation',
      children: `Are you sure you want to remove this image as a Terms of Service violation? The uploader will be notified.`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: image ? () => mutate({ id: image.id }) : undefined,
    });
  };

  return children({ onClick: handleTosViolation, isLoading });
}

type ButtonCallbackProps = {
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading: boolean;
  }) => React.ReactElement;
  onSuccess?: () => void;
};
