import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';

export function useCommentMutations() {
  const { entityType, entityId, addCreated, markRemoved, created } = useCommentSection();
  const utils = trpc.useUtils();
  const refresh = () => utils.commentv3.invalidate();
  const fail = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  const createComment = trpc.commentv3.create.useMutation({
    onError: fail('Could not save comment'),
  });
  const updateComment = trpc.commentv3.update.useMutation({
    onError: fail('Could not save comment'),
  });
  const remove = trpc.commentv3.delete.useMutation({ onError: fail('Could not delete comment') });
  const hide = trpc.commentv3.toggleHide.useMutation({ onError: fail('Unable to hide comment') });
  const pin = trpc.commentv3.togglePinned.useMutation({ onError: fail('Unable to pin comment') });
  const tos = trpc.commentv3.setTosViolation.useMutation({
    onError: fail('Unable to remove comment'),
  });
  const lock = trpc.commentv3.toggleLock.useMutation({ onError: fail('Unable to lock replies') });
  const mute = trpc.commentv3.toggleCommentMute.useMutation({
    onError: fail('Unable to update thread notifications'),
  });

  return {
    saving: createComment.isPending || updateComment.isPending,
    async create(content: string, parent: { id: number; depth: number } | null) {
      const saved = await createComment.mutateAsync({
        entityType,
        entityId,
        parentId: parent?.id,
        content,
      });
      addCreated(parent?.id ?? null, saved);
      await utils.cosmetic.getStickerBalances.invalidate();
      void refresh();
      return saved;
    },
    async edit(comment: CommentV3Comment, content: string) {
      const saved = await updateComment.mutateAsync({ id: comment.id, content });
      await utils.cosmetic.getStickerBalances.invalidate();
      await refresh();
      return saved;
    },
    async delete(comment: CommentV3Comment) {
      await remove.mutateAsync({ id: comment.id });
      // One with replies stays as a placeholder for them, which the refetch brings back.
      if (!comment.replyCount && !created[comment.id]?.length) markRemoved(comment.id);
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      void refresh();
    },
    async toggleHide(comment: CommentV3Comment) {
      await hide.mutateAsync({ id: comment.id });
      await refresh();
    },
    async togglePin(comment: CommentV3Comment) {
      await pin.mutateAsync({ id: comment.id });
      await refresh();
    },
    async toggleLock(comment: CommentV3Comment) {
      await lock.mutateAsync({ id: comment.id });
      await refresh();
    },
    settingTos: tos.isPending,
    async removeAsTos(comment: CommentV3Comment) {
      const result = await tos.mutateAsync({ id: comment.id });
      showSuccessNotification({
        title: 'Comment removed as a ToS violation',
        message: result.notified
          ? 'The author has been notified and any matching reports were actioned.'
          : 'Any matching reports were actioned.',
      });
      await refresh();
    },
    togglingMute: mute.isPending,
    async toggleMute(comment: CommentV3Comment) {
      const result = await mute.mutateAsync({ commentId: comment.id });
      // The server answers what is left: a mute higher up can still be suppressing.
      await utils.commentv3.getCommentMuted.invalidate({ commentId: comment.id });
      showSuccessNotification({
        message: result.muted
          ? "You won't be notified about replies under this comment"
          : 'Your mute on this comment has been removed',
      });
    },
  };
}
