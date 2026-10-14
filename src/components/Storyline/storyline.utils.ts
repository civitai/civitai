import { trpc } from '~/utils/trpc';

/** Whether a post is already a chapter, and of which storyline. */
export function useStorylineForPost(postId: number, { enabled = true } = {}) {
  const { data, isLoading } = trpc.storyline.getForPosts.useQuery(
    { postIds: [postId] },
    { enabled }
  );
  return { storyline: data?.[postId] ?? null, isLoading: enabled && isLoading };
}

/** A scheduled post is not published yet, and a storyline cannot start from it. */
export const isPublished = (post: { publishedAt?: Date | null }) =>
  !!post.publishedAt && post.publishedAt <= new Date();
