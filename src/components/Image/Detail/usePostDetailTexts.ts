import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * A post's text items for a post-scoped viewer. Only chapter posts carry text, so `post.get` is
 * asked only once the storyline chip's own read (same key, usually cached) marks the post as one.
 */
export function usePostDetailTexts(postId: number | undefined, { enabled }: { enabled: boolean }) {
  const textOn = !!useFeatureFlags().storylineText;
  const storylinesOn = useStorylinesEnabled();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const active = enabled && textOn && storylinesOn && !!postId;
  const { data: chapters } = trpc.storyline.getForPosts.useQuery(
    { postIds: postId ? [postId] : [], browsingLevel },
    { enabled: active, staleTime: 60_000 }
  );
  const isChapter = active && !!postId && !!chapters?.[postId];
  const { data: post } = trpc.post.get.useQuery({ id: postId ?? 0 }, { enabled: isChapter });
  return useMemo<DetailText[] | undefined>(() => {
    if (!isChapter || !post || post.id !== postId || !post.texts.length) return undefined;
    return post.texts.map((text) => ({ ...text, postId: post.id }));
  }, [isChapter, post, postId]);
}
