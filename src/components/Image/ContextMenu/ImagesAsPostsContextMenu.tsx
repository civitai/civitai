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
import { showSuccessNotification } from '~/utils/notifications';
import { ImageContextMenuWrapper } from '~/components/Image/ContextMenu/ContextMenu';

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

  const handleUpdateGallerySettings = async ({
    imageId,
    user,
  }: {
    imageId?: number;
    user?: { id: number; username: string | null };
  }) => {
    if (!showModerationOptions) return;
    if (model) {
      await toggle({
        modelId: model.id,
        hiddenImages: imageId
          ? { modelVersionId: currentModelVersionId, imageIds: [imageId] }
          : undefined,
        users: user ? [user] : undefined,
      }).catch(() => null);

      if (filters.hidden)
        await queryUtils.image.getImagesAsPostsInfinite.invalidate({ ...filters });
    } else if (model3dId) {
      await toggleModel3D({
        model3dId,
        hiddenImages: imageId ? [imageId] : undefined,
        users: user ? [user] : undefined,
      }).catch(() => null);

      if (filters.hidden)
        await queryUtils.image.getImagesAsPostsInfinite.invalidate({ ...filters });
    }
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
    if (source.kind === 'model3d') {
      const imageAlreadyHidden = !!model3dGallerySettings?.hiddenImages.includes(image.id);
      const userAlreadyHidden = !!model3dGallerySettings?.hiddenUsers.find(
        (u) => u.id === image.user?.id
      );
      return (
        <>
          <Menu.Label key="menu-label">Gallery Moderation</Menu.Label>
          <Menu.Item
            key="hide-image-gallery"
            onClick={() => handleUpdateGallerySettings({ imageId: image.id })}
          >
            {imageAlreadyHidden ? 'Unhide image from gallery' : 'Hide image from gallery'}
          </Menu.Item>
          <Menu.Item
            key="hide-user-gallery"
            onClick={() => handleUpdateGallerySettings({ user: image.user })}
          >
            {userAlreadyHidden ? 'Show content from this user' : 'Hide content from this user'}
          </Menu.Item>
        </>
      );
    }

    const imageAlreadyHidden = gallerySettings
      ? gallerySettings.hiddenImages?.[currentModelVersionId]?.includes(image.id)
      : false;
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
        <Menu.Item
          key="hide-image-gallery"
          onClick={() => handleUpdateGallerySettings({ imageId: image.id })}
        >
          {imageAlreadyHidden ? 'Unhide image from gallery' : 'Hide image from gallery'}
        </Menu.Item>
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
