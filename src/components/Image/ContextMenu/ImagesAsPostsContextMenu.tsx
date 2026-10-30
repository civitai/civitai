import { Menu, Stack, Text } from '@mantine/core';
import {
  ImageMenuItems,
  type ImageContextMenuProps,
} from '~/components/Image/ContextMenu/ImageMenuItems';
import {
  useGallerySettings,
  useModel3DGallerySettings,
} from '~/components/Image/AsPosts/gallery.utils';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider';
import { constants } from '~/server/common/constants';
import { IconPinned, IconPinnedOff } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { ImageContextMenuWrapper } from '~/components/Image/ContextMenu/ContextMenu';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';

export function ImagesAsPostsContextMenu({ image }: { image: ImageContextMenuProps['image'] }) {
  return (
    <ImageContextMenuWrapper image={image}>
      <ImagesAsPostsContextMenuItems image={image} />
    </ImageContextMenuWrapper>
  );
}

function ImagesAsPostsContextMenuItems({ image }: ImageContextMenuProps) {
  const { showModerationOptions, filters, source } = useImagesAsPostsInfiniteContext();
  // Hide-image / pin-post moderation forks per source: Model uses
  // per-modelVersion keyed maps (`useGallerySettings`); Model3D uses a flat
  // image-id list (`useModel3DGallerySettings`) and skips pinning entirely.
  const model = source.kind === 'model' ? source.model : undefined;
  const model3dId = source.kind === 'model3d' ? source.id : undefined;
  const { gallerySettings, toggle } = useGallerySettings({ modelId: model?.id });
  const { gallerySettings: model3dGallerySettings, toggle: toggleModel3D } =
    useModel3DGallerySettings({ model3dId });
  const queryUtils = trpc.useUtils();

  const currentModelVersionId = filters.modelVersionId as number;

  const hiddenImageIds =
    (model
      ? gallerySettings?.hiddenImages?.[currentModelVersionId]
      : model3dGallerySettings?.hiddenImages) ?? [];

  const handleUpdateGallerySettings = async ({
    imageIds,
    user,
  }: {
    imageIds?: number[];
    user?: { id: number; username: string | null };
  }) => {
    if (!showModerationOptions) return;
    if (model) {
      await toggle({
        modelId: model.id,
        hiddenImages: imageIds ? { modelVersionId: currentModelVersionId, imageIds } : undefined,
        users: user ? [user] : undefined,
      }).catch(() => null);

      if (filters.hidden)
        await queryUtils.image.getImagesAsPostsInfinite.invalidate({ ...filters });
    } else if (model3dId) {
      await toggleModel3D({
        model3dId,
        hiddenImages: imageIds,
        users: user ? [user] : undefined,
      }).catch(() => null);

      if (filters.hidden)
        await queryUtils.image.getImagesAsPostsInfinite.invalidate({ ...filters });
    }
  };

  // The toggle unhides every id it is given when ANY of them is already hidden, so hiding
  // must send only the post's not-yet-hidden images and unhiding only its hidden ones.
  const handleTogglePostHidden = ({ postId, hide }: { postId: number; hide: boolean }) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: hide ? 'Hide post from gallery' : 'Unhide post from gallery',
        message: hide
          ? 'Every image in this post will be hidden from this gallery.'
          : 'Every image in this post will be shown in this gallery again.',
        labels: { cancel: 'Cancel', confirm: hide ? 'Hide post' : 'Unhide post' },
        onConfirm: async () => {
          const postImageIds = await queryUtils.post.getImageIds
            .fetch({ id: postId })
            .catch((error: Error) => {
              showErrorNotification({ title: 'Unable to load post images', error });
              return [];
            });
          const imageIds = postImageIds.filter((id) => hiddenImageIds.includes(id) !== hide);
          if (imageIds.length) await handleUpdateGallerySettings({ imageIds });
        },
      },
    });
  };

  const handlePinPost = async ({
    postId,
    alreadyPinned,
  }: {
    postId: number;
    alreadyPinned: boolean;
  }) => {
    if (model) {
      try {
        await toggle({
          modelId: model.id,
          pinnedPosts: { modelVersionId: currentModelVersionId, postIds: [postId] },
        });

        showSuccessNotification({
          title: alreadyPinned ? 'Post unpinned' : 'Post pinned',
          message: alreadyPinned
            ? 'This post has been removed from the top of the gallery'
            : 'This post has been pinned and will appear at the top of the gallery for new visitors',
        });
      } catch (error) {
        return null;
      }
    }
  };

  const moderationOptions = (image: ImageContextMenuProps['image']) => {
    if (!showModerationOptions) return null;
    const imageAlreadyHidden = hiddenImageIds.includes(image.id);
    const hideImageItems = (
      <>
        <Menu.Item
          key="hide-image-gallery"
          onClick={() => handleUpdateGallerySettings({ imageIds: [image.id] })}
        >
          {imageAlreadyHidden ? 'Unhide image from gallery' : 'Hide image from gallery'}
        </Menu.Item>
        {image.postId ? (
          <Menu.Item
            key="hide-post-gallery"
            onClick={() =>
              handleTogglePostHidden({ postId: image.postId as number, hide: !imageAlreadyHidden })
            }
          >
            {imageAlreadyHidden ? 'Unhide post from gallery' : 'Hide post from gallery'}
          </Menu.Item>
        ) : null}
      </>
    );

    if (source.kind === 'model3d') {
      const userAlreadyHidden = !!model3dGallerySettings?.hiddenUsers.find(
        (u) => u.id === image.user?.id
      );
      return (
        <>
          <Menu.Label key="menu-label">Gallery Moderation</Menu.Label>
          {hideImageItems}
          <Menu.Item
            key="hide-user-gallery"
            onClick={() => handleUpdateGallerySettings({ user: image.user })}
          >
            {userAlreadyHidden ? 'Show content from this user' : 'Hide content from this user'}
          </Menu.Item>
        </>
      );
    }

    const userAlreadyHidden = gallerySettings
      ? gallerySettings.hiddenUsers.findIndex((u) => u.id === image.user?.id) > -1
      : false;
    const alreadyPinned =
      gallerySettings && image.postId
        ? gallerySettings.pinnedPosts?.[currentModelVersionId]?.includes(image.postId)
        : false;
    const maxedOut = gallerySettings
      ? (gallerySettings.pinnedPosts?.[currentModelVersionId]?.length ?? 0) >=
        constants.modelGallery.maxPinnedPosts
      : false;

    return (
      <>
        <Menu.Label key="menu-label">Gallery Moderation</Menu.Label>
        {image.postId ? (
          <Menu.Item
            key="pin-post"
            leftSection={
              alreadyPinned ? (
                <IconPinnedOff size={16} stroke={1.5} />
              ) : (
                <IconPinned size={16} stroke={1.5} />
              )
            }
            style={{ alignItems: maxedOut ? 'flex-start' : 'center' }}
            disabled={!alreadyPinned && maxedOut}
            onClick={() => handlePinPost({ postId: image.postId as number, alreadyPinned })}
          >
            {alreadyPinned ? (
              'Unpin this post'
            ) : (
              <Stack gap={2}>
                <Text inherit inline>
                  Pin this post
                </Text>
                {maxedOut && (
                  <Text size="xs" c="yellow">
                    Pin limit reached
                  </Text>
                )}
              </Stack>
            )}
          </Menu.Item>
        ) : null}
        {hideImageItems}
        <Menu.Item
          key="hide-user-gallery"
          onClick={() => handleUpdateGallerySettings({ user: image.user })}
        >
          {userAlreadyHidden ? 'Show content from this user' : 'Hide content from this user'}
        </Menu.Item>
      </>
    );
  };

  return <ImageMenuItems image={image} additionalMenuItems={moderationOptions(image)} />;
}
