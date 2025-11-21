import { Menu, useMantineTheme } from '@mantine/core';
import { IconEdit, IconFlag, IconTrash, IconInfoCircle, IconShieldHalf } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { openReportModal } from '~/components/Dialog/triggers/report';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function PostControls({
  postId,
  userId,
  children,
}: {
  postId: number;
  userId: number;
  isModelVersionPost?: number | null;
  children: React.ReactElement;
}) {
  const router = useRouter();
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const isOwner = userId === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;
  const isOwnerOrModerator = isOwner || isModerator;
  const enqueuNsfwLevelUpdateMutation = trpc.post.enqueueNsfwLevelUpdate.useMutation({
    onSuccess: () => showSuccessNotification({ message: 'Nsfw level update queued' }),
  });
  function handleEnqueueNsfwLevelUpdate() {
    enqueuNsfwLevelUpdateMutation.mutate({ id: postId });
  }

  return (
    <Menu position="bottom-end" transitionProps={{ transition: 'pop-top-right' }} withArrow>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {/* TODO.posts - reports */}
        {isModerator && (
          <Menu.Item
            leftSection={<IconShieldHalf size={14} stroke={1.5} />}
            color="yellow"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              handleEnqueueNsfwLevelUpdate();
            }}
          >
            Enqueue NsfwLevel Update
          </Menu.Item>
        )}
        {isOwnerOrModerator && (
          <>
            <DeletePostButton postId={postId}>
              {({ onClick }) => (
                <Menu.Item
                  color={theme.colors.red[6]}
                  leftSection={<IconTrash size={14} stroke={1.5} />}
                  onClick={() => onClick()}
                >
                  Delete Post
                </Menu.Item>
              )}
            </DeletePostButton>
            <Menu.Item
              leftSection={<IconEdit size={14} stroke={1.5} />}
              onClick={() => router.push(`/posts/${postId}/edit`)}
            >
              Edit Post
            </Menu.Item>
          </>
        )}
        {(!isOwner || !currentUser) && (
          <LoginRedirect reason="report-content">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={() => openReportModal({ entityType: ReportEntity.Post, entityId: postId })}
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        )}
        {isModerator && (
          <>
            <Menu.Label>Moderator</Menu.Label>
            {env.NEXT_PUBLIC_POST_LOOKUP_URL && (
              <Menu.Item
                component="a"
                target="_blank"
                leftSection={<IconInfoCircle size={14} stroke={1.5} />}
                href={`${env.NEXT_PUBLIC_POST_LOOKUP_URL}${postId}`}
              >
                Lookup Post
              </Menu.Item>
            )}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
