import { useMemo } from 'react';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import { useStorylineForPost } from '~/components/Storyline/storyline.queries';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * A post's text items for a post-scoped viewer. Only chapter posts carry text, so `post.get` is
 * asked only once the post's storyline read (usually cached by the entry chip) marks it as one.
 */
export function usePostDetailTexts(postId: number | undefined, { enabled }: { enabled: boolean }) {
  const textOn = !!useFeatureFlags().storylineText;
  const active = enabled && textOn;
  const isChapter = !!useStorylineForPost(postId, { enabled: active }) && active;
  const { data: post } = trpc.post.get.useQuery({ id: postId ?? 0 }, { enabled: isChapter });
  return useMemo<DetailText[] | undefined>(() => {
    if (!isChapter || !post || post.id !== postId || !post.texts.length) return undefined;
    return post.texts.map((text) => ({ ...text, postId: post.id }));
  }, [isChapter, post, postId]);
}
