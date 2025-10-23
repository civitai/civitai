import { Text } from '@mantine/core';
import { useCommentsContext, useNewCommentStore } from '../CommentsProvider';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import React from 'react';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';
import produce from 'immer';
import { getQueryKey } from '@trpc/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { CommentV2GetInfinite } from '~/types/router';

export function DeleteComment({
  children,
  id,
  entityId,
  entityType,
}: {
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: () => void;
    isLoading?: boolean;
  }) => React.ReactElement;
  id: number;
} & CommentConnectorInput) {
  const queryUtils = trpc.useUtils();
  const { created } = useCommentsContext();
  const { mutate, isLoading } = trpc.commentv2.delete.useMutation({
    async onSuccess(response, request) {
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      if (created.some((x) => x.id === request.id)) {
        useNewCommentStore.getState().deleteComment(entityType, entityId, id);
      } else {
        // Use getQueryKey to match all infinite queries for this entity (regardless of sort/limit/hidden params)
        await queryUtils.commentv2.getInfinite.cancel();

        const queryKey = getQueryKey(trpc.commentv2.getInfinite);
        queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
          produce(state, (old?: InfiniteData<CommentV2GetInfinite>) => {
            if (!old?.pages?.length) return;

            // Remove the comment from all pages
            for (const page of old.pages) {
              if (page?.comments) {
                page.comments = page.comments.filter((x) => x.id !== request.id);
              }
            }
          })
        );
      }
      queryUtils.commentv2.getCount.setData({ entityId, entityType }, (old = 1) => old - 1);
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete comment',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });

  const handleDeleteComment = () => {
    openConfirmModal({
      title: 'Delete comment',
      children: <Text size="sm">Are you sure you want to delete this comment?</Text>,
      centered: true,
      labels: { confirm: 'Delete comment', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => mutate({ id }),
    });
  };

  return children({ onClick: handleDeleteComment, isLoading });
}
