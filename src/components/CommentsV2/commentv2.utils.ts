import { ToggleHideCommentInput } from '~/server/schema/commentv2.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';

export const useQueryThreadComments = (filters: CommentConnectorInput) => {
  const { data, isLoading: loadingComments } = trpc.commentv2.getThreadDetails.useQuery(filters);
  const { data: count = 0, isLoading: loadingCount } = trpc.commentv2.getCount.useQuery(filters);

  return {
    comments: data?.comments ?? [],
    loadingComments,
    count,
    loadingCount,
  };
};

export const useMutateComment = () => {
  const queryUtils = trpc.useContext();
  const toggleHideCommentMutation = trpc.commentv2.toggleHide.useMutation({
    async onSuccess() {
      await queryUtils.commentv2.getThreadDetails.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Unable to hide comment', error: new Error(error.message) });
    },
  });

  const handleToggleHide = (payload: ToggleHideCommentInput) => {
    if (toggleHideCommentMutation.isLoading) return;
    return toggleHideCommentMutation.mutateAsync(payload);
  };

  return {
    toggleHide: handleToggleHide,
    toggling: toggleHideCommentMutation.isLoading,
  };
};
