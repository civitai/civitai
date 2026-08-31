import type { ToggleHideCommentInput } from '~/server/schema/commentv2.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Where a surface scrolls to when a single thread is opened — the way back has to be on screen. */
export const RETURN_TO_ROOT_THREAD_ID = 'return-to-root-thread';

export const useMutateComment = () => {
  const queryUtils = trpc.useUtils();
  const toggleHideCommentMutation = trpc.commentv2.toggleHide.useMutation({
    async onSuccess(_, { entityType, entityId }) {
      await Promise.all([
        queryUtils.commentv2.getInfinite.invalidate(),
        queryUtils.commentv2.getCount.invalidate({ entityType, entityId }),
        queryUtils.commentv2.getCount.invalidate({ entityType, entityId, hidden: true }),
      ]);
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

  const setTosViolationMutation = trpc.commentv2.setTosViolation.useMutation({
    async onSuccess(result) {
      await queryUtils.commentv2.getInfinite.invalidate();
      showSuccessNotification({
        title: 'Comment removed as a ToS violation',
        message: result.notified
          ? 'The author has been notified and any matching reports were actioned.'
          : 'Any matching reports were actioned.',
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to remove comment',
        error: new Error(error.message),
      });
    },
  });

  const handleToggleHide = (payload: ToggleHideCommentInput) => {
    if (toggleHideCommentMutation.isPending) return;
    return toggleHideCommentMutation.mutateAsync(payload);
  };

  async function handleTogglePinned({ id, entityType, entityId }: ToggleHideCommentInput) {
    togglePinnedMutation.mutateAsync({ id, entityType, entityId }).then(async () => {
      await Promise.all([
        queryUtils.commentv2.getInfinite.invalidate(),
        queryUtils.commentv2.getCount.invalidate({ entityType, entityId }),
        queryUtils.commentv2.getCount.invalidate({ entityType, entityId, hidden: true }),
      ]);
    });
  }

  return {
    toggleHide: handleToggleHide,
    togglePinned: handleTogglePinned,
    setTosViolation: setTosViolationMutation.mutateAsync,
    settingTosViolation: setTosViolationMutation.isPending,
  };
};
