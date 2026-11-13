import { usePostStorylineDraft } from '~/components/Storyline/editor/usePostStorylineDraft';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { isPublished, useStorylineForPost } from '~/components/Storyline/storyline.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type EditorPost = { id: number; user: { id: number }; publishedAt?: Date | null };

/**
 * What the post editor knows of the post's storyline: the pending link of a draft, or the chapter
 * a published post already is. `inStoryline` is true for either, for the post's author only (the
 * server answers no one else).
 */
export function usePostStorylineMode(post: EditorPost) {
  const enabled = useStorylinesEnabled();
  const currentUser = useCurrentUser();
  const { pending, isLoading } = usePostStorylineDraft(post.id);
  const isOwner = currentUser?.id === post.user.id;
  const { storyline: chapter } = useStorylineForPost(post.id, {
    enabled: enabled && isOwner && !pending && !isLoading && isPublished(post),
  });
  return { pending, chapter, inStoryline: !!pending || !!chapter };
}
