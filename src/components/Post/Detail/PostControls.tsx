import { ActionIcon, Menu, useMantineTheme } from '@mantine/core';
import { IconDotsVertical, IconTrash, IconEdit } from '@tabler/icons';
import { useRouter } from 'next/router';
import React from 'react';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function PostControls({
  postId,
  userId,
  children,
}: {
  postId: number;
  userId: number;
  children: React.ReactElement;
}) {
  const router = useRouter();
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const isOwner = userId === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;
  const isOwnerOrModerator = isOwner || isModerator;
  // TODO.posts - add ability to report a post
  if (!isOwnerOrModerator) return null;

  return (
    <Menu position="bottom-end" transition="pop-top-right">
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {/* TODO.posts - reports */}
        {isOwnerOrModerator && (
          <>
            <Menu.Item
              icon={<IconEdit size={14} stroke={1.5} />}
              onClick={() => router.push(`/posts/${postId}/edit`)}
            >
              Edit Post
            </Menu.Item>
            <DeletePostButton postId={postId}>
              {({ onClick }) => (
                <Menu.Item
                  color={theme.colors.red[6]}
                  icon={<IconTrash size={14} stroke={1.5} />}
                  onClick={onClick}
                >
                  Delete Post
                </Menu.Item>
              )}
            </DeletePostButton>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
