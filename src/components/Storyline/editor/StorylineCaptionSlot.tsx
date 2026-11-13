import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { StorylineImageCaptionBox } from '~/components/Storyline/editor/StorylineImageCaptionBox';
import { usePostStorylineMode } from '~/components/Storyline/editor/usePostStorylineMode';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import type { PostEditImageDetail } from '~/server/services/post.service';

/**
 * The caption box under one image of the post editor. In a story the caption is the writing, so it
 * sits under the picture rather than in "Edit details"; any other post, and anyone but the author,
 * gets nothing.
 */
export function StorylineCaptionSlot({
  post,
  image,
}: {
  post: { id: number; user: { id: number }; publishedAt?: Date | null };
  image: Pick<PostEditImageDetail, 'id' | 'url' | 'type' | 'metadata'>;
}) {
  const currentUser = useCurrentUser();
  const { inStoryline } = usePostStorylineMode(post);
  const { id, url, type, metadata } = image;
  if (!inStoryline || id <= 0 || currentUser?.id !== post.user.id) return null;

  return (
    <StorylineImageCaptionBox
      postId={post.id}
      imageId={id}
      media={
        <EdgeMedia
          src={url}
          width={metadata?.width ?? DEFAULT_EDGE_IMAGE_WIDTH}
          type={type}
          loading="lazy"
          className="rounded-none"
          anim={type === 'video'}
        />
      }
    />
  );
}
