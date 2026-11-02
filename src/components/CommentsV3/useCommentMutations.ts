import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { emptyReactionCounts } from '~/shared/utils/comment-reactions';
import type { RouterOutput } from '~/types/router';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';

/** A comment the write just returned, in the shape the v3 reads give, so it shows before a refetch. */
function asV3(
  saved: RouterOutput['commentv2']['upsert'],
  parent: { id: number; depth: number } | null
): CommentV3Comment {
  return {
    id: saved.id,
    deleted: false,
    parentId: parent?.id ?? null,
    replyToId: null,
    depth: parent ? parent.depth + 1 : 0,
    content: saved.content,
    createdAt: saved.createdAt,
    updatedAt: saved.createdAt,
    pinnedAt: saved.pinnedAt,
    hidden: !!saved.hidden,
    tosViolation: saved.tosViolation,
    reactionCount: 0,
    user: saved.user,
    reactions: emptyReactionCounts(),
    myReactions: [],
    replyCount: 0,
  };
}

/**
 * Every write the suite makes, in one place. Until a surface's writes flip to CommentV3 they go
 * through the `commentv2` procedures (the mirror copies them into CommentV3), then refresh the v3
 * reads; a surface's write flip changes the procedures here and nothing in the components.
 */
export function useCommentMutations() {
  const { entityType, entityId, addCreated, markRemoved, created } = useCommentSection();
  const utils = trpc.useUtils();
  const refresh = () => utils.commentv3.invalidate();
  const fail = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  // A reply is written against its parent comment; a top-level comment against the surface.
  const target = (parent: { id: number } | null) =>
    parent ? { entityType: 'comment' as const, entityId: parent.id } : { entityType, entityId };

  const upsert = trpc.commentv2.upsert.useMutation({ onError: fail('Could not save comment') });
  const remove = trpc.commentv2.delete.useMutation({ onError: fail('Could not delete comment') });
  const hide = trpc.commentv2.toggleHide.useMutation({ onError: fail('Unable to hide comment') });
  const pin = trpc.commentv2.togglePinned.useMutation({ onError: fail('Unable to pin comment') });
  const tos = trpc.commentv2.setTosViolation.useMutation({
    onError: fail('Unable to remove comment'),
  });
  const mute = trpc.commentv2.toggleThreadMute.useMutation({
    onError: fail('Unable to update thread notifications'),
  });

  return {
    saving: upsert.isPending,
    async create(content: string, parent: { id: number; depth: number } | null) {
      const saved = await upsert.mutateAsync({ ...target(parent), content });
      addCreated(parent?.id ?? null, asV3(saved, parent));
      await utils.cosmetic.getStickerBalances.invalidate();
      void refresh();
      return saved;
    },
    async edit(comment: CommentV3Comment, content: string) {
      const saved = await upsert.mutateAsync({
        id: comment.id,
        content,
        ...target(comment.parentId ? { id: comment.parentId } : null),
      });
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
      await hide.mutateAsync({ id: comment.id, entityType, entityId });
      await refresh();
    },
    async togglePin(comment: CommentV3Comment) {
      await pin.mutateAsync({ id: comment.id, entityType, entityId });
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
      await utils.commentv2.getThreadMuted.invalidate({ commentId: comment.id });
      showSuccessNotification({
        message: result.muted
          ? "You won't be notified about replies in this thread"
          : 'Your mute on this thread has been removed',
      });
    },
  };
}
