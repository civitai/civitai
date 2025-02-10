import { ToggleHideCommentInput } from '~/server/schema/commentv2.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useMutateComment = () => {
  const queryUtils = trpc.useContext();
  const toggleHideCommentMutation = trpc.commentv2.toggleHide.useMutation({
    async onSuccess(response, { entityType, entityId }) {
      await queryUtils.commentv2.getThreadDetails.invalidate({ entityType, entityId });
      await queryUtils.commentv2.getThreadDetails.invalidate({
        entityType,
        entityId,
        hidden: true,
      });
      await queryUtils.commentv2.getCount.invalidate({ entityType, entityId });
      await queryUtils.commentv2.getCount.invalidate({ entityType, entityId, hidden: true });
    },
    onError(error) {
      showErrorNotification({ title: 'Unable to hide comment', error: new Error(error.message) });
    },
  });

  const togglePinnedMutation = trpc.commentv2.togglePinned.useMutation({
    onError(error) {
      showErrorNotification({ title: 'Unable to pin comment', error: new Error(error.message) });
    },
  });

  const handleToggleHide = (payload: ToggleHideCommentInput) => {
    if (toggleHideCommentMutation.isLoading) return;
    return toggleHideCommentMutation.mutateAsync(payload);
  };

  async function handleTogglePinned({ id, entityType, entityId }: ToggleHideCommentInput) {
    togglePinnedMutation.mutateAsync({ id }).then(async () => {
      await queryUtils.commentv2.getThreadDetails.invalidate({ entityType, entityId });
      await queryUtils.commentv2.getThreadDetails.invalidate({
        entityType,
        entityId,
        hidden: true,
      });
      await queryUtils.commentv2.getCount.invalidate({ entityType, entityId });
      await queryUtils.commentv2.getCount.invalidate({ entityType, entityId, hidden: true });
    });
  }

  return {
    toggleHide: handleToggleHide,
    togglePinned: handleTogglePinned,
  };
};
