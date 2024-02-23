import { Menu } from '@mantine/core';
import { CollectionType } from '@prisma/client';
import { IconBookmark } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openContext } from '~/providers/CustomModalsProvider';

export function SaveToCollection({
  imageId,
  postId,
  context,
}: {
  imageId?: number;
  postId?: number;
  context: 'image' | 'post';
}) {
  if (context === 'post' && !postId) return null;
  if (context === 'image' && !imageId) return null;

  const handleClick = () => {
    if (context === 'post') openContext('addToCollection', { postId, type: CollectionType.Post });
    if (context === 'image')
      openContext('addToCollection', { imageId, type: CollectionType.Image });
  };

  return (
    <LoginRedirect reason="add-to-collection">
      <Menu.Item icon={<IconBookmark size={14} stroke={1.5} />} onClick={handleClick}>
        Save {context} to collection
      </Menu.Item>
    </LoginRedirect>
  );
}
