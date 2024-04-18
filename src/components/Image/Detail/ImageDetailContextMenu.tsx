import { Menu, Loader, Text } from '@mantine/core';
import { closeModal, openConfirmModal } from '@mantine/modals';
import React, { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  IconTrash,
  IconBan,
  IconLock,
  IconPencil,
  IconRadar2,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { ToggleLockComments } from '~/components/CommentsV2';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { DeleteImage } from '~/components/Image/DeleteImage/DeleteImage';
import { useRouter } from 'next/router';
import { NextLink } from '@mantine/next';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useReportCsamImages } from '~/components/Image/image.utils';
import { imageStore } from '~/store/image.store';

/*
TODO.gallery
  - we really need to implement stores for our key entities (model, review, image) that will allow us to update values without having to deal with the react-query cache. For an example, refer to the TosViolationButton component below.
*/

export function ImageDetailContextMenu({ children }: { children: React.ReactElement }) {
  const { image, isMod, isOwner } = useImageDetailContext();
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const queryUtils = trpc.useContext();

  if (!image) return null;

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
    imageStore.setImage(image.id, { tosViolation: true });
    router.back();
  };

  return (
    <Menu opened={opened} onChange={setOpened} closeOnClickOutside={!loading}>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {(isMod || isOwner) && (
          <>
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
            {image.postId && (
              <Menu.Item
                component={NextLink}
                icon={<IconPencil size={14} stroke={1.5} />}
                href={`/posts/${image.postId}/edit`}
              >
                Edit Image Post
              </Menu.Item>
            )}
          </>
        )}
        {!isOwner && (
          <>
            <HideImageButton key="hide-image-button" as="menu-item" imageId={image.id} />
            <ReportMenuItem
              label="Report Image"
              loginReason="report-content"
              onReport={() =>
                openContext('report', {
                  entityType: ReportEntity.Image,
                  entityId: image.id,
                })
              }
            />
          </>
        )}
        {isMod && (
          <>
            <Menu.Label>Moderator</Menu.Label>
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
            <ReportCsamButton>
              {({ onClick }) => (
                <Menu.Item icon={<IconAlertTriangle size={14} stroke={1.5} />} onClick={onClick}>
                  Report CSAM
                </Menu.Item>
              )}
            </ReportCsamButton>

            <RescanImageButton>
              {({ onClick, isLoading }) => (
                <Menu.Item
                  icon={isLoading ? <Loader size={14} /> : <IconRadar2 size={14} stroke={1.5} />}
                  onClick={() => handleClick(onClick)}
                  disabled={isLoading}
                  closeMenuOnClick={false}
                >
                  Rescan Image
                </Menu.Item>
              )}
            </RescanImageButton>
            {image && (
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
          </>
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

function RescanImageButton({ children, onSuccess }: ButtonCallbackProps) {
  const { image } = useImageDetailContext();

  const { mutate, isLoading } = trpc.image.rescan.useMutation({
    async onSuccess() {
      closeModal('confirm-tos-violation');
      onSuccess?.();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not rescan image, please try again',
      });
    },
  });
  const handle = () => {
    if (!image) return;
    mutate({ id: image.id });
  };

  return children({ onClick: handle, isLoading });
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

function ReportCsamButton({ children, onSuccess }: ButtonCallbackProps) {
  const router = useRouter();
  const { image } = useImageDetailContext();

  const { csamReports } = useFeatureFlags();

  const { mutate, isLoading } = useReportCsamImages({
    async onSuccess() {
      onSuccess?.();
    },
  });

  const onClick = () => {
    if (!image) return;
    if (csamReports) router.push(`/moderator/csam/${image.user.id}?imageId=${image.id}`);
    else mutate({ imageIds: [image.id] });
  };

  return children({ onClick, isLoading });
}
