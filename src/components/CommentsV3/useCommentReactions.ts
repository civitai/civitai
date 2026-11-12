import { useMemo } from 'react';
import type { ReactionMetrics } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CommentV3Comment } from './types';

/** A comment's reaction counts and the viewer's own reactions, in the shape `Reactions` takes. */
export function useCommentReactions(comment: CommentV3Comment) {
  const currentUser = useCurrentUser();
  const metrics = useMemo(
    (): ReactionMetrics => ({
      likeCount: comment.reactions.Like,
      dislikeCount: comment.reactions.Dislike,
      heartCount: comment.reactions.Heart,
      laughCount: comment.reactions.Laugh,
      cryCount: comment.reactions.Cry,
    }),
    [comment.reactions]
  );
  const reactions = useMemo(
    () =>
      currentUser
        ? comment.myReactions.map((reaction) => ({ userId: currentUser.id, reaction }))
        : [],
    [comment.myReactions, currentUser]
  );
  return { metrics, reactions };
}
