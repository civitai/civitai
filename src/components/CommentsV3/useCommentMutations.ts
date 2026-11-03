import { constants } from '~/server/common/constants';
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
 * Every write the suite makes, in one place. A surface in `constants.comments.v3WriteSurfaces`
 * writes through the `commentv3` procedures; any other still writes through `commentv2` (the
 * mirror copies those into CommentV3).
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

  const v3 = constants.comments.v3WriteSurfaces.includes(entityType);
  const upsert = trpc.commentv2.upsert.useMutation({ onError: fail('Could not save comment') });
  const remove = trpc.commentv2.delete.useMutation({ onError: fail('Could not delete comment') });
  const hide = trpc.commentv2.toggleHide.useMutation({ onError: fail('Unable to hide comment') });
  const pin = trpc.commentv2.togglePinned.useMutation({ onError: fail('Unable to pin comment') });
  const tos = trpc.commentv2.setTosViolation.useMutation({
    onError: fail('Unable to remove comment'),
  });
  const createV3 = trpc.commentv3.create.useMutation({ onError: fail('Could not save comment') });
  const updateV3 = trpc.commentv3.update.useMutation({ onError: fail('Could not save comment') });
  const removeV3 = trpc.commentv3.delete.useMutation({ onError: fail('Could not delete comment') });
  const hideV3 = trpc.commentv3.toggleHide.useMutation({ onError: fail('Unable to hide comment') });
  const pinV3 = trpc.commentv3.togglePinned.useMutation({ onError: fail('Unable to pin comment') });
  const tosV3 = trpc.commentv3.setTosViolation.useMutation({
    onError: fail('Unable to remove comment'),
  });
  const mute = trpc.commentv2.toggleThreadMute.useMutation({
    onError: fail('Unable to update thread notifications'),
  });

  return {
    saving: upsert.isPending || createV3.isPending || updateV3.isPending,
    async create(content: string, parent: { id: number; depth: number } | null) {
      const saved = v3
        ? await createV3.mutateAsync({ entityType, entityId, parentId: parent?.id, content })
        : asV3(await upsert.mutateAsync({ ...target(parent), content }), parent);
      addCreated(parent?.id ?? null, saved);
      await utils.cosmetic.getStickerBalances.invalidate();
      void refresh();
      return saved;
    },
    async edit(comment: CommentV3Comment, content: string) {
      const saved = v3
        ? await updateV3.mutateAsync({ id: comment.id, content })
        : await upsert.mutateAsync({
            id: comment.id,
            content,
            ...target(comment.parentId ? { id: comment.parentId } : null),
          });
      await utils.cosmetic.getStickerBalances.invalidate();
      await refresh();
      return saved;
    },
    async delete(comment: CommentV3Comment) {
      await (v3 ? removeV3 : remove).mutateAsync({ id: comment.id });
      // One with replies stays as a placeholder for them, which the refetch brings back.
      if (!comment.replyCount && !created[comment.id]?.length) markRemoved(comment.id);
      showSuccessNotification({
        title: 'Your comment has been deleted',
        message: 'Successfully deleted the comment',
      });
      void refresh();
    },
    async toggleHide(comment: CommentV3Comment) {
      if (v3) await hideV3.mutateAsync({ id: comment.id });
      else await hide.mutateAsync({ id: comment.id, entityType, entityId });
      await refresh();
    },
    async togglePin(comment: CommentV3Comment) {
      if (v3) await pinV3.mutateAsync({ id: comment.id });
      else await pin.mutateAsync({ id: comment.id, entityType, entityId });
      await refresh();
    },
    settingTos: tos.isPending || tosV3.isPending,
    async removeAsTos(comment: CommentV3Comment) {
      const result = await (v3 ? tosV3 : tos).mutateAsync({ id: comment.id });
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
