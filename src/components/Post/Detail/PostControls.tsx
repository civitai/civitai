import { Menu, useMantineTheme } from '@mantine/core';
import {
  IconEdit,
  IconFlag,
  IconTrash,
  IconShieldHalf,
  IconSpeakerphone,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { openReportModal } from '~/components/Dialog/triggers/report';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { GalleryPromotionModal } from '~/components/Promotion/GalleryPromotionModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { moderatorBulkImageManagerPath } from '~/shared/constants/moderator-app';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ModeratorLookupMenuItem } from '~/components/Moderation/ModeratorLookupMenuItem';

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
  const features = useFeatureFlags();
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
        {isOwner && features.creatorPromotions && (
          <Menu.Item
            leftSection={<IconSpeakerphone size={14} stroke={1.5} />}
            onClick={() =>
              dialogStore.trigger({ component: GalleryPromotionModal, props: { postId } })
            }
          >
            Promote in a gallery
          </Menu.Item>
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
            <ModeratorLookupMenuItem path={moderatorBulkImageManagerPath('post', postId)}>
              Lookup Post
            </ModeratorLookupMenuItem>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
