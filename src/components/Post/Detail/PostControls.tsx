import { Menu, useMantineTheme } from '@mantine/core';
import { IconEdit, IconFlag, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';

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

  return (
    <Menu position="bottom-end" transition="pop-top-right">
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {/* TODO.posts - reports */}
        {isOwnerOrModerator && (
          <>
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
            <Menu.Item
              icon={<IconEdit size={14} stroke={1.5} />}
              onClick={() => router.push(`/posts/${postId}/edit`)}
            >
              Edit Post
            </Menu.Item>
          </>
        )}
        {(!isOwner || !currentUser) && (
          <LoginRedirect reason="report-content">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openContext('report', { entityType: ReportEntity.Post, entityId: postId })
              }
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
