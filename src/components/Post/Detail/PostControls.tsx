import { ActionIcon, Menu, useMantineTheme } from '@mantine/core';
import { IconDotsVertical, IconTrash, IconEdit } from '@tabler/icons';
import { useRouter } from 'next/router';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function PostControls({ postId, userId }: { postId: number; userId: number }) {
  const router = useRouter();
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const isOwner = userId === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;
  const isOwnerOrModerator = isOwner || isModerator;
  return (
    <Menu position="bottom-end" transition="pop-top-right">
      <Menu.Target>
        <ActionIcon variant="outline">
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
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
