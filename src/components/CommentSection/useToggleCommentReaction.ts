import { useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReactionDetails } from '~/server/selectors/reaction.selector';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type ToggleChange = { added?: ReactionDetails; removed?: ReactionDetails };

/** Comment v1 reaction toggle, applied optimistically to `comment.getReactions`. */
export function useToggleCommentReaction(commentId: number) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  // `isPending` lands a render late, so two clicks in one frame both passed it.
  // One lock per reaction: a quick Like then Heart are different toggles, only a repeat is dropped.
  const inFlight = useRef(new Set<ReviewReactions>());

  // Undo only this reaction's optimistic change against the current cache: another reaction may be
  // in flight, and a whole-list snapshot would overwrite its row.
  const revert = (id: number, change: ToggleChange | undefined) => {
    if (!change) return;
    queryUtils.comment.getReactions.setData({ commentId: id }, (old = []) => {
      if (change.added) {
        const { reaction, user } = change.added;
        return old.filter((r) => !(r.reaction === reaction && r.user.id === user.id));
      }
      const { removed } = change;
      return removed && !old.some((r) => r.id === removed.id) ? [...old, removed] : old;
    });
  };

  const mutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }): Promise<ToggleChange | undefined> {
      await queryUtils.comment.getReactions.cancel({ commentId: id });
      if (!currentUser) return;

      const previousReactions = queryUtils.comment.getReactions.getData({ commentId: id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };
      const added: ReactionDetails = {
        id: latestReaction.id + 1,
        reaction,
        user: { id: currentUser.id, username: currentUser.username ?? '' },
      };
      const removed = previousReactions.find(
        (r) => r.reaction === reaction && r.user.id === currentUser.id
      );
      queryUtils.comment.getReactions.setData({ commentId: id }, (old = []) =>
        removed ? old.filter((r) => r.id !== removed.id) : [...old, added]
      );
      return removed ? { removed } : { added };
    },
    onSuccess(result, variables, context) {
      if (result === 'ignored') revert(variables.id, context);
    },
    onError(_error, variables, context) {
      revert(variables.id, context);
    },
    onSettled(_data, _error, variables) {
      inFlight.current.delete(variables.reaction);
    },
  });

  const toggle = (reaction: ReviewReactions) => {
    if (inFlight.current.has(reaction)) return;
    inFlight.current.add(reaction);
    mutation.mutate({ id: commentId, reaction });
  };

  return { toggle, isPending: mutation.isPending };
}
