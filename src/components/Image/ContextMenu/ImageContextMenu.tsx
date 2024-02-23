import { ActionIcon, Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { cloneElement, useRef } from 'react';
import { DeleteImage } from '~/components/Image/ContextMenu/MenuItems/DeleteImage';
import { EditPost } from '~/components/Image/ContextMenu/MenuItems/EditPost';
import { ReportImage } from '~/components/Image/ContextMenu/MenuItems/ReportImage';
import { SaveToCollection } from '~/components/Image/ContextMenu/MenuItems/SaveToCollection';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type ImageContextMenuProps = {
  id: number;
  postId?: number;
  userId?: number;
  user?: { id: number };
  // url?: string | null;
  collectionId?: number;
  needsReview?: string;
  context?: 'image' | 'post';
};

type CustomMenuItem<TProps extends Record<string, unknown> = any> = {
  Component: React.ComponentType<TProps>;
  props?: TProps;
  group?: 'default' | 'owner' | 'moderator';
  hide?: boolean;
};

function createMenuItem<TProps extends Record<string, unknown>>(props: CustomMenuItem<TProps>) {
  return { group: 'default', ...props };
}

export function ImageContextMenu({
  id: imageId,
  postId,
  user,
  userId,
  collectionId,
  needsReview,
  context = 'image',
}: ImageContextMenuProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const isOwner = !!currentUser && (currentUser.id === user?.id || currentUser.id === userId);
  const isModerator = !!currentUser?.isModerator;

  const menuItemsRef = useRef([
    createMenuItem({
      Component: SaveToCollection,
      props: { imageId, postId, context },
      hide: !features.collections,
    }),
    createMenuItem({ Component: ReportImage, props: { imageId }, hide: isOwner }),
    createMenuItem({
      Component: DeleteImage,
      props: { imageId },
      group: 'owner',
      hide: context !== 'image',
    }),
    createMenuItem({ Component: EditPost, props: { postId }, group: 'owner' }),
  ]);

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
      <Menu.Dropdown>
        {menuItemsRef.current.map(({ Component, props }, index) => (
          <Component key={index} {...(props as any)} />
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
