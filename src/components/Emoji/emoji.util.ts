import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import { trpc } from '~/utils/trpc';

export type ResolvedEmoji = {
  id: number;
  name: string;
  slug: string;
  url: string;
  animated?: boolean;
};

const obtainedTime = (value?: Date) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? 0 : time;
};

/**
 * Owned emoji, most-recently-obtained first — the order that decides which
 * cosmetic a duplicated `:slug:` resolves to at send time.
 */
export function useOwnedEmoji() {
  const { data, isLoading } = useQueryUserCosmetics();

  const emoji = useMemo(() => {
    const owned = data?.emoji ?? [];
    return owned
      .map(({ id, name, data: emojiData, obtainedAt }) => ({
        id,
        name,
        slug: emojiData?.slug,
        url: emojiData?.url,
        animated: emojiData?.animated,
        obtainedAt,
      }))
      .filter((x) => !!x.slug && !!x.url)
      .sort((a, b) => obtainedTime(b.obtainedAt) - obtainedTime(a.obtainedAt));
  }, [data?.emoji]);

  const bySlug = useMemo(() => {
    const map = new Map<string, ResolvedEmoji>();
    for (const item of emoji) if (!map.has(item.slug)) map.set(item.slug, item);
    return map;
  }, [emoji]);

  return { emoji, bySlug, isLoading };
}

export function useEmojiCosmetic(cosmeticId: number) {
  const { data, isLoading } = trpc.cosmetic.getEmoji.useQuery(
    { ids: [cosmeticId] },
    { enabled: cosmeticId > 0, staleTime: Infinity, gcTime: Infinity }
  );

  return { emoji: data?.[0], isLoading };
}
