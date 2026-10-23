import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { usePostStorylineDraft } from '~/components/Storyline/editor/usePostStorylineDraft';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { isPublished, useStorylineForPost } from '~/components/Storyline/storyline.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type EditorPost = { id: number; user: { id: number }; publishedAt?: Date | null };

/**
 * Above the post form, only for a post that belongs to a storyline: a draft started from the
 * storyline flow, or a post that is already a chapter. Any other post gets no storyline UI.
 */
export function StorylineEditorHeader({ post }: { post: EditorPost }) {
  const enabled = useStorylinesEnabled();
  const currentUser = useCurrentUser();
  const { pending, isLoading } = usePostStorylineDraft(post.id);
  const isOwner = currentUser?.id === post.user.id;
  const { storyline: chapter } = useStorylineForPost(post.id, {
    enabled: enabled && isOwner && !pending && !isLoading && isPublished(post),
  });

  if (pending?.parentChapter)
    return (
      <StorylineEditorBanner
        variant="continue"
        storyline={{ id: pending.storyline.id, title: pending.storyline.title }}
        chapterNumber={pending.parentChapter.depth + 2}
      />
    );
  if (pending)
    return (
      <StorylineEditorBanner
        variant="start"
        storyline={{ id: pending.storyline.id, title: pending.storyline.title }}
      />
    );
  if (!pending && chapter)
    return (
      <StorylineEditorBanner
        variant="chapter"
        storyline={{ id: chapter.storylineId, title: chapter.title }}
        chapterNumber={chapter.depth + 1}
      />
    );
  return null;
}
