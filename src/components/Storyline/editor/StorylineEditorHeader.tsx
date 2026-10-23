import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { usePostStorylineMode } from '~/components/Storyline/editor/usePostStorylineMode';

type EditorPost = { id: number; user: { id: number }; publishedAt?: Date | null };

/**
 * Above the post form, only for a post that belongs to a storyline: a draft started from the
 * storyline flow, or a post that is already a chapter. Any other post gets no storyline UI.
 */
export function StorylineEditorHeader({ post }: { post: EditorPost }) {
  const { pending, chapter } = usePostStorylineMode(post);

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
