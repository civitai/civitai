import { Menu, Loader } from '@mantine/core';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { useState } from 'react';
import { useGalleryDetailContext } from './GalleryDetailProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { IconTrash, IconBan, IconLock } from '@tabler/icons';
import { ToggleLockComments } from '~/components/CommentsV2';

/*
TODO.gallery
  - we really need to implement stores for our key entities (model, review, image) that will allow us to update values without having to deal with the react-query cache. For an example, refer to the TosViolationButton component below.
*/

export function GalleryDetailContextMenu({ children }: { children: React.ReactElement }) {
  const { image, isMod } = useGalleryDetailContext();
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    setLoading(false);
    setOpened(false);
  };
  const handleClick = (onClick: () => void) => {
    setLoading(true);
    onClick();
  };

  return (
    <Menu opened={opened} onChange={setOpened} closeOnClickOutside={!loading}>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        <DeleteButton onSuccess={handleClose}>
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
        </DeleteButton>
        {isMod && (
          <TosViolationButton onSuccess={handleClose}>
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

function DeleteButton({ children, onSuccess }: ButtonCallbackProps) {
  const { image, close } = useGalleryDetailContext();
  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.image.delete.useMutation({
    async onSuccess() {
      if (image && image.connections?.modelId) {
        await queryUtils.model.getById.invalidate({ id: image.connections?.modelId });

        if (image.connections?.reviewId) {
          await queryUtils.review.getDetail.invalidate({ id: image.connections?.reviewId });
          await queryUtils.review.getAll.invalidate({ modelId: image.connections?.modelId });
        }
      }
      close();
      onSuccess?.();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const handleDeleteImage = () => {
    if (image) mutate({ id: image.id });
  };

  return children({ onClick: handleDeleteImage, isLoading });
}

function TosViolationButton({ children, onSuccess }: ButtonCallbackProps) {
  const { image, close } = useGalleryDetailContext();
  const queryUtils = trpc.useContext();

  const { mutate, isLoading } = trpc.image.setTosViolation.useMutation({
    async onSuccess() {
      if (image) {
        await queryUtils.image.getGalleryImageDetail.invalidate({ id: image.id });
        if (image.connections?.modelId)
          await queryUtils.model.getById.invalidate({ id: image.connections?.modelId });
      }
      closeModal('confirm-tos-violation');
      close();
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
      children: `Are you sure you want to report this image for a Terms of Service violation? Once marked, it won't show up for other people`,
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
