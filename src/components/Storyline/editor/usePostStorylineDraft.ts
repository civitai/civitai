import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { trpc } from '~/utils/trpc';

/**
 * The storyline a post is being drafted into, or null when it is not a storyline post. The server
 * answers only the author (and moderators), so a null can also be a viewer who is neither.
 */
export function usePostStorylineDraft(postId: number) {
  const enabled = useStorylinesEnabled() && postId > 0;
  const { data, isLoading } = trpc.storyline.getPendingForPost.useQuery({ postId }, { enabled });
  return { pending: data ?? null, isLoading: enabled && isLoading };
}
