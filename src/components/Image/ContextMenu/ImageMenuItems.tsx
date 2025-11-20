import { Menu } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconBookmark,
  IconEye,
  IconFlag,
  IconPencil,
  IconRadar2,
  IconTrash,
} from '@tabler/icons-react';
import Router from 'next/router';
import React from 'react';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { useDeleteImage } from '~/components/Image/hooks/useDeleteImage';
import { useReportTosViolation } from '~/components/Image/hooks/useReportTosViolation';
import { useRescanImage } from '~/components/Image/hooks/useRescanImage';
import { useReportCsamImages } from '~/components/Image/image.utils';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ToggleSearchableMenuItem } from '~/components/MenuItems/ToggleSearchableMenuItem';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { CollectionType, CosmeticEntity } from '~/shared/utils/prisma/enums';
import { NextLink } from '~/components/NextLink/NextLink';
import { useToggleImageFlag } from '~/components/Image/hooks/useToggleImageFlag';
import { useImageContextMenuContext } from '~/components/Image/ContextMenu/ImageContextMenuProvider';
import { useImageContext } from '~/components/Image/ImageProvider';

export type ImageContextMenuProps = {
  image: Omit<ImageProps, 'tags'> & { ingestion?: ImageIngestionStatus };
  context?: 'image' | 'post';
  additionalMenuItems?: React.ReactNode;
  noDelete?: boolean;
  children?: React.ReactElement;
};

export function ImageMenuItems(props: ImageContextMenuProps & { disableDelete?: boolean }) {
  const { image, context = 'image', additionalMenuItems, disableDelete } = props;
  const { isOwner, isModerator } = useImageContext();
  const features = useFeatureFlags();
  const { id: imageId, postId, user, userId } = image;
  const _userId = user?.id ?? userId;
  const isImage = context === 'image';

  const handleSaveClick = () => {
    if (context === 'post' && postId)
      openAddToCollectionModal({ props: { postId, type: CollectionType.Post } });
    if (isImage) openAddToCollectionModal({ props: { imageId, type: CollectionType.Image } });
  };

  const handleReportClick = () =>
    openReportModal({ entityType: ReportEntity.Image, entityId: imageId });

  const deleteImage = useDeleteImage();
  const rescanImage = useRescanImage();
  const reportTos = useReportTosViolation();
  const reportCsamMutation = useReportCsamImages();
  const handleReportCsam = () => {
    if (!_userId) return;
    if (features.csamReports)
      window.open(`/moderator/csam/${_userId}?imageId=${imageId}`, '_blank');
    else reportCsamMutation.mutate({ imageIds: [imageId] });
  };
  const toggleImageFlag = useToggleImageFlag();

  const { additionalMenuItemsAfter, additionalMenuItemsBefore } = useImageContextMenuContext();

  return (
    <>
      {additionalMenuItemsBefore?.(image)}
      {/* GENERAL */}
      {isOwner && (
        <>
          <AddToShowcaseMenuItem entityType="Image" entityId={imageId} />
          {isImage && (
            <AddArtFrameMenuItem
              entityType={CosmeticEntity.Image}
              entityId={imageId}
              image={image}
              currentCosmetic={image.cosmetic}
            />
          )}
        </>
      )}
      {(context === 'post' || postId) && (
        <LoginRedirect reason="add-to-collection">
          <Menu.Item
            leftSection={<IconBookmark size={14} stroke={1.5} />}
            onClick={handleSaveClick}
          >
            Save {context} to collection
          </Menu.Item>
        </LoginRedirect>
      )}
      {postId && !Router.query.postId && (
        <Menu.Item
          component={NextLink}
          href={`/posts/${postId}`}
          leftSection={<IconEye size={14} stroke={1.5} />}
        >
          View Post
        </Menu.Item>
      )}
      {!isOwner && (
        <>
          <LoginRedirect reason="report-content">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={handleReportClick}
            >
              Report image
            </Menu.Item>
          </LoginRedirect>
          <HideImageButton as="menu-item" imageId={imageId} />
          {_userId && <HideUserButton as="menu-item" userId={_userId} />}
        </>
      )}
      {isModerator && (
        <>
          <Menu.Item
            leftSection={<IconFlag size={14} stroke={1.5} />}
            onClick={() =>
              toggleImageFlag({
                id: image.id,
                flag: 'minor',
              })
            }
          >
            {image.minor ? 'Remove minor flag' : 'Flag as minor'}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFlag size={14} stroke={1.5} />}
            onClick={() =>
              toggleImageFlag({
                id: image.id,
                flag: 'poi',
              })
            }
          >
            {image.poi ? 'Remove POI flag' : 'Flag as POI'}
          </Menu.Item>
        </>
      )}
      {/* OWNER */}
      {(isOwner || isModerator) && (
        <>
          {postId && (
            <Menu.Item
              leftSection={<IconPencil size={14} stroke={1.5} />}
              onClick={() => Router.push(`/posts/${postId}/edit`)}
            >
              Edit Post
            </Menu.Item>
          )}

          {!disableDelete && (
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={() => deleteImage({ imageId })}
            >
              Delete
            </Menu.Item>
          )}
        </>
      )}
      {additionalMenuItemsAfter?.(image)}
      {additionalMenuItems}
      {/* MODERATOR */}
      {isModerator && (
        <>
          <Menu.Label>Moderator</Menu.Label>
          <Menu.Item
            leftSection={<IconBan size={14} stroke={1.5} />}
            onClick={() => reportTos({ imageId })}
          >
            Remove as TOS Violation
          </Menu.Item>
          <Menu.Item
            leftSection={<IconRadar2 size={14} stroke={1.5} />}
            onClick={() => rescanImage({ imageId })}
          >
            Rescan Image
          </Menu.Item>
          <Menu.Item
            leftSection={<IconAlertTriangle size={14} stroke={1.5} />}
            onClick={handleReportCsam}
          >
            Report CSAM
          </Menu.Item>
          {postId && <ToggleSearchableMenuItem entityType="Post" entityId={postId} />}
        </>
      )}
    </>
  );
}
