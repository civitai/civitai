import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { usePostStorylineMode } from '~/components/Storyline/editor/usePostStorylineMode';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type EditorPost = { id: number; user: { id: number }; publishedAt?: Date | null };

/**
 * Above the post form, only for a post that belongs to a storyline: a draft started from the
 * storyline flow, or a post that is already a chapter. Any other post gets no storyline UI.
 */
export function StorylineEditorHeader({ post }: { post: EditorPost }) {
  const currentUser = useCurrentUser();
  const { pending, chapter } = usePostStorylineMode(post);
  const isOwner = currentUser?.id === post.user.id;
  const utils = trpc.useUtils();
  const removePending = trpc.storyline.removePending.useMutation({
    onSuccess: () => utils.storyline.getPendingForPost.invalidate({ postId: post.id }),
    onError: (error) =>
      showErrorNotification({ title: 'Could not remove the post from the storyline', error }),
  });
  // A moderator also sees the link, but only the author may remove it; a scheduled post counts
  // as published here, as it does on the server.
  const removal =
    isOwner && !post.publishedAt
      ? {
          onRemove: () => removePending.mutate({ postId: post.id }),
          removing: removePending.isPending,
        }
      : {};

  if (pending?.parentChapter)
    return (
      <StorylineEditorBanner
        variant="continue"
        storyline={{
          id: pending.storyline.id,
          title: pending.storyline.title,
          maxNsfwLevel: pending.storyline.maxNsfwLevel,
        }}
        chapterNumber={pending.parentChapter.depth + 2}
        {...removal}
      />
    );
  if (pending)
    return (
      <StorylineEditorBanner
        variant="start"
        storyline={{ id: pending.storyline.id, title: pending.storyline.title }}
        {...removal}
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
