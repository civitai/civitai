import { Menu } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import Router from 'next/router';

export function EditPost({ postId }: { postId?: number }) {
  if (!postId) return null;
  const handleClick = () => {
    Router.push(`/posts/${postId}/edit`);
  };

  return (
    <Menu.Item icon={<IconPencil size={14} stroke={1.5} />} onClick={handleClick}>
      Edit Post
    </Menu.Item>
  );
}
