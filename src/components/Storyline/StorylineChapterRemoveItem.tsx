import {
  canRemoveStorylineChapter,
  RemoveChapterMenuItem,
} from '~/components/Storyline/RemoveChapterMenuItem';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/** "Remove from storyline" in the image menu, for the chapter being read in storyline mode. */
export function StorylineChapterRemoveItem({ imageId }: { imageId: number }) {
  const storyline = useStorylineMode();
  const currentUser = useCurrentUser();
  if (!storyline.active || !currentUser) return null;
  const chapterId = storyline.chapterIdOfImage(imageId);
  const chapter = storyline.path.chapters.find((c) => c.chapterId === chapterId);
  if (
    !chapter?.post ||
    !canRemoveStorylineChapter({
      depth: chapter.depth,
      authorId: chapter.post.userId,
      ownerId: storyline.path.storyline.userId,
      viewer: currentUser,
    })
  )
    return null;
  const byAuthor = chapter.post.userId === currentUser.id;

  return (
    <RemoveChapterMenuItem
      chapterId={chapter.chapterId}
      title={chapter.post.title || 'this chapter'}
      hasChildren={chapter.childCount > 0}
      byAuthor={byAuthor}
      onRemoved={storyline.leave}
    />
  );
}
