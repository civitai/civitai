import { ActionIcon, Menu } from '@mantine/core';
import { IconDotsVertical, IconFlag, IconPencil, IconTrash } from '@tabler/icons-react';
import Router from 'next/router';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { IconBookmark } from '@tabler/icons-react';
import { CollectionType } from '@prisma/client';

type ImageContextMenuProps = {
  id: number;
  postId?: number;
  userId?: number;
  user?: { id: number };
  collectionId?: number;
  needsReview?: string;
  context?: 'image' | 'post';
};

// type CustomMenuItem<TProps extends Record<string, unknown> = any> = {
//   Component: React.ComponentType<TProps>;
//   props?: TProps;
//   group?: 'default' | 'owner' | 'moderator';
//   hide?: boolean;
// };

// function createMenuItem<TProps extends Record<string, unknown>>(props: CustomMenuItem<TProps>) {
//   return { group: 'default', ...props };
// }
const menuItems = {
  addToCollection: { Component: AddToCollection },
  reportImage: { Component: ReportImage },
};

export function ImageContextMenu(props: ImageContextMenuProps) {
  // const currentUser = useCurrentUser();
  // const features = useFeatureFlags();
  // const isOwner = !!currentUser && (currentUser.id === user?.id || currentUser.id === userId);
  // const isModerator = !!currentUser?.isModerator;

  // const menuItemsRef = useRef([
  //   createMenuItem({
  //     Component: SaveToCollection,
  //     props: { imageId, postId, context },
  //     hide: !features.collections,
  //   }),
  //   createMenuItem({ Component: ReportImage, props: { imageId }, hide: isOwner }),
  //   createMenuItem({ Component: EditPost, props: { postId }, group: 'owner' }),
  //   createMenuItem({
  //     Component: DeleteImage,
  //     props: { imageId },
  //     hide: context !== 'image',
  //     group: 'owner',
  //   }),
  // ]);

  return (
    <Menu>
      <Menu.Target>
        <ActionIcon
          variant="transparent"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical
            size={26}
            color="#fff"
            filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
          />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {/* <ImageMenuItems {...props} /> */}
        {/* {menuItemsRef.current.map(({ Component, props }, index) => (
          <Component key={index} {...(props as any)} />
        ))} */}
      </Menu.Dropdown>
    </Menu>
  );
}

function AddToCollection({ imageId, postId, context }: ImageContextMenuProps) {
  if (context === 'post' && !postId) return null;

  const handleClick = () => {
    if (context === 'post') openContext('addToCollection', { postId, type: CollectionType.Post });
    if (context === 'image')
      openContext('addToCollection', { imageId, type: CollectionType.Image });
  };

  return (
    <LoginRedirect reason="add-to-collection">
      <Menu.Item icon={<IconBookmark size={14} stroke={1.5} />} onClick={handleClick}>
        Add to collection
      </Menu.Item>
    </LoginRedirect>
  );
}

function ReportImage({ imageId }: ImageContextMenuProps) {
  const handleClick = () =>
    openContext('report', { entityType: ReportEntity.Image, entityId: imageId }, { zIndex: 1000 });

  return (
    <LoginRedirect reason="report-content">
      <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleClick}>
        Report image
      </Menu.Item>
    </LoginRedirect>
  );
}

// function ImageMenuItems({
//   id: imageId,
//   postId,
//   user,
//   userId,
//   collectionId,
//   needsReview,
//   context = 'image',
// }: ImageContextMenuProps) {
//   const currentUser = useCurrentUser();
//   const features = useFeatureFlags();
//   const isOwner = !!currentUser && (currentUser.id === user?.id || currentUser.id === userId);
//   const isModerator = !!currentUser?.isModerator;

//   const deleteImageMutation = trpc.image.delete.useMutation({
//     onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
//   });

//   const handleDeleteClick = () =>
//     dialogStore.trigger({
//       component: ConfirmDialog,
//       props: {
//         title: 'Delete image',
//         message: 'Are you sure you want to delete this image?',
//         labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
//         confirmProps: { color: 'red', loading: deleteImageMutation.isLoading },
//         onConfirm: async () => await deleteImageMutation.mutateAsync({ id: imageId }),
//       },
//     });

//   const handleSaveClick = () => {
//     if (context === 'post' && postId)
//       openContext('addToCollection', { postId, type: CollectionType.Post });
//     if (context === 'image')
//       openContext('addToCollection', { imageId, type: CollectionType.Image });
//   };

//   const handleReportClick = () =>
//     openContext('report', { entityType: ReportEntity.Image, entityId: imageId }, { zIndex: 1000 });

//   return (
//     <>
//       {/* GENERAL */}
//       <LoginRedirect reason="add-to-collection">
//         <Menu.Item icon={<IconBookmark size={14} stroke={1.5} />} onClick={handleSaveClick}>
//           Save {context} to collection
//         </Menu.Item>
//       </LoginRedirect>
//       <LoginRedirect reason="report-content">
//         <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleReportClick}>
//           Report image
//         </Menu.Item>
//       </LoginRedirect>
//       {/* OWNER */}
//       {(isOwner || isModerator) && (
//         <>
//           <Menu.Label>Owner</Menu.Label>
//           {postId && (
//             <Menu.Item
//               icon={<IconPencil size={14} stroke={1.5} />}
//               onClick={() => Router.push(`/posts/${postId}/edit`)}
//             >
//               Edit Post
//             </Menu.Item>
//           )}
//           <Menu.Item
//             color="red"
//             icon={<IconTrash size={14} stroke={1.5} />}
//             onClick={handleDeleteClick}
//           >
//             Delete
//           </Menu.Item>
//         </>
//       )}
//       {/* MODERATOR */}
//       {isModerator && <></>}
//     </>
//   );
// }
