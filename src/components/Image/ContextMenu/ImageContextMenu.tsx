import {
  ActionIconProps,
  Box,
  Group,
  HoverCard,
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconBookmark,
  IconCheck,
  IconEye,
  IconFlag,
  IconPencil,
  IconRadar2,
  IconRecycle,
  IconRestore,
  IconTrash,
  IconUser,
  IconUserMinus,
  IconUserOff,
} from '@tabler/icons-react';
import Router, { useRouter } from 'next/router';
import React, { createContext, useContext } from 'react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { openReportModal } from '~/components/Dialog/dialog-registry';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { useDeleteImage } from '~/components/Image/hooks/useDeleteImage';
import { useReportTosViolation } from '~/components/Image/hooks/useReportTosViolation';
import { useRescanImage } from '~/components/Image/hooks/useRescanImage';
import { useReportCsamImages } from '~/components/Image/image.utils';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ToggleSearchableMenuItem } from '~/components/MenuItems/ToggleSearchableMenuItem';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { CollectionType, CosmeticEntity, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { imageStore, useImageStore } from '~/store/image.store';
import { trpc } from '~/utils/trpc';

type ImageContextMenuProps = {
  image: Omit<ImageProps, 'tags'> & { ingestion?: ImageIngestionStatus };
  context?: 'image' | 'post';
  additionalMenuItems?: React.ReactNode;
  noDelete?: boolean;
  children?: React.ReactElement;
};

export function ImageContextMenu({
  context,
  additionalMenuItems,
  noDelete = false,
  image,
  className,
  children,
  ...actionIconProps
}: ImageContextMenuProps & ActionIconProps) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const props = {
    image,
    context,
    additionalMenuItems,
  };
  const isOwner =
    !!currentUser && (currentUser.id === image.user?.id || currentUser.id === image.userId);
  const isModerator = !!currentUser?.isModerator;

  const ContextMenu = (
    <Menu withinPortal withArrow zIndex={1000}>
      <Menu.Target>
        {children ?? (
          <ActionIconDotsVertical
            className={!image.needsReview ? className : undefined}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            {...actionIconProps}
          />
        )}
      </Menu.Target>
      <Menu.Dropdown
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <ImageMenuItems
          {...props}
          isModerator={isModerator}
          isOwner={isOwner}
          disableDelete={router.pathname.includes('/collections') || noDelete}
        />
      </Menu.Dropdown>
    </Menu>
  );

  if (image.needsReview || image.ingestion === 'Blocked')
    return (
      <Group spacing={4} className={className}>
        <NeedsReviewBadge {...props} isModerator={isModerator} isOwner={isOwner} />
        {ContextMenu}
      </Group>
    );

  return ContextMenu;
}

function ImageMenuItems(
  props: ImageContextMenuProps & { isOwner: boolean; isModerator: boolean; disableDelete?: boolean }
) {
  const {
    image,
    context = 'image',
    additionalMenuItems,
    isOwner,
    isModerator,
    disableDelete,
  } = props;
  const features = useFeatureFlags();
  const { id: imageId, postId, user, userId } = image;
  const _userId = user?.id ?? userId;
  const isImage = context === 'image';

  const handleSaveClick = () => {
    if (context === 'post' && postId)
      openContext('addToCollection', { postId, type: CollectionType.Post });
    if (isImage) openContext('addToCollection', { imageId, type: CollectionType.Image });
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
          <Menu.Item icon={<IconBookmark size={14} stroke={1.5} />} onClick={handleSaveClick}>
            Save {context} to collection
          </Menu.Item>
        </LoginRedirect>
      )}
      {postId && !Router.query.postId && (
        <Menu.Item
          icon={<IconEye size={14} stroke={1.5} />}
          onClick={() => triggerRoutedDialog({ name: 'postDetail', state: { postId: postId } })}
        >
          View Post
        </Menu.Item>
      )}
      {!isOwner && (
        <>
          <LoginRedirect reason="report-content">
            <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleReportClick}>
              Report image
            </Menu.Item>
          </LoginRedirect>
          <HideImageButton as="menu-item" imageId={imageId} />
          {_userId && <HideUserButton as="menu-item" userId={_userId} />}
        </>
      )}
      {/* OWNER */}
      {(isOwner || isModerator) && (
        <>
          {postId && (
            <Menu.Item
              icon={<IconPencil size={14} stroke={1.5} />}
              onClick={() => Router.push(`/posts/${postId}/edit`)}
            >
              Edit Post
            </Menu.Item>
          )}

          {!disableDelete && (
            <Menu.Item
              color="red"
              icon={<IconTrash size={14} stroke={1.5} />}
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
            icon={<IconBan size={14} stroke={1.5} />}
            onClick={() => reportTos({ imageId })}
          >
            Remove as TOS Violation
          </Menu.Item>
          <Menu.Item
            icon={<IconRadar2 size={14} stroke={1.5} />}
            onClick={() => rescanImage({ imageId })}
          >
            Rescan Image
          </Menu.Item>
          <Menu.Item icon={<IconAlertTriangle size={14} stroke={1.5} />} onClick={handleReportCsam}>
            Report CSAM
          </Menu.Item>
          {postId && <ToggleSearchableMenuItem entityType="Post" entityId={postId} />}
          {!postId && (
            <Menu.Item
              key="view-image-detail"
              icon={<IconEye size={14} stroke={1.5} />}
              onClick={() =>
                triggerRoutedDialog({
                  name: 'imageDetail',
                  state: { imageId },
                })
              }
            >
              View image detail
            </Menu.Item>
          )}
        </>
      )}
    </>
  );
}

function NeedsReviewBadge({
  image,
  isOwner,
  isModerator,
}: ImageContextMenuProps & { isOwner: boolean; isModerator: boolean }) {
  const { needsReview: initialNeedsReview, ingestion: initialIngestion, id: imageId } = image;
  const { needsReview, ingestion } = useImageStore({
    id: imageId,
    needsReview: initialNeedsReview,
    ingestion: initialIngestion,
  });
  const moderateImagesMutation = trpc.image.moderate.useMutation();
  if (!needsReview && ingestion !== 'Blocked') return null;

  const handleModerate = (action: 'accept' | 'delete' | 'removeName' | 'mistake') => {
    if (!isModerator) return;
    moderateImagesMutation.mutate({
      ids: [imageId],
      needsReview: action === 'accept' ? null : undefined,
      reviewAction: action !== 'accept' ? action : undefined,
      reviewType: 'minor',
    });
    imageStore.setImage(imageId, { needsReview: null, ingestion: 'Scanned' });
  };

  const Badge = (
    <ThemeIcon size="lg" color={needsReview === 'csam' && isModerator ? 'red' : 'yellow'}>
      {needsReview === 'poi' ? (
        <IconUser strokeWidth={2.5} size={26} />
      ) : (
        <IconAlertTriangle strokeWidth={2.5} size={26} />
      )}
    </ThemeIcon>
  );

  if (needsReview && needsReview !== 'csam' && isModerator) {
    return (
      <Menu position="bottom">
        <Menu.Target>
          <Box
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {Badge}
          </Box>
        </Menu.Target>
        <Menu.Dropdown
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Menu.Item
            onClick={() => handleModerate('accept')}
            icon={<IconCheck size={14} stroke={1.5} />}
          >
            Approve
          </Menu.Item>
          {needsReview === 'poi' && (
            <Menu.Item
              onClick={() => handleModerate('mistake')}
              icon={<IconUserOff size={14} stroke={1.5} />}
            >
              Not POI
            </Menu.Item>
          )}
          {needsReview === 'poi' && (
            <Menu.Item
              onClick={() => handleModerate('removeName')}
              icon={<IconUserMinus size={14} stroke={1.5} />}
            >
              Remove Name
            </Menu.Item>
          )}
          <Menu.Item
            onClick={() => handleModerate('delete')}
            icon={<IconTrash size={14} stroke={1.5} />}
          >
            Reject
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  } else if (isModerator && ingestion === 'Blocked') {
    return (
      <Menu position="bottom">
        <Menu.Target>
          <Box
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <ThemeIcon size="lg" color="yellow">
              <IconRecycle strokeWidth={2.5} size={20} />
            </ThemeIcon>
          </Box>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => handleModerate('accept')}
            icon={<IconRestore size={14} stroke={1.5} />}
          >
            Restore
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  } else {
    return (
      <HoverCard width={200} withArrow>
        <HoverCard.Target>{Badge}</HoverCard.Target>
        <HoverCard.Dropdown p={8}>
          <Stack spacing={0}>
            <Text weight="bold" size="xs">
              Flagged for review
            </Text>
            <Text size="xs">
              {`This image won't be visible to other users until it's reviewed by our moderators.`}
            </Text>
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }
}

type ImageContextMenuCtx = {
  additionalMenuItemsBefore?: (data: ImageProps) => React.ReactNode;
  additionalMenuItemsAfter?: (data: ImageProps) => React.ReactNode;
};

const ImageContextMenuContext = createContext<ImageContextMenuCtx>({});
const useImageContextMenuContext = () => useContext(ImageContextMenuContext);

export function ImageContextMenuProvider({
  children,
  ...props
}: ImageContextMenuCtx & { children: React.ReactNode }) {
  return (
    <ImageContextMenuContext.Provider value={props}>{children}</ImageContextMenuContext.Provider>
  );
}
