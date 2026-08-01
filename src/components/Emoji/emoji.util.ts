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

/** Matches the `ids` cap on `getEmojiCosmeticsSchema`. */
const EMOJI_FETCH_CHUNK = 100;

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

/**
 * One request per 100 distinct ids for a whole surface, rather than one per
 * rendered emoji — tRPC request batching sits behind a feature flag that is off
 * by default, so per-component queries would be per-component HTTP requests.
 */
export function useEmojiCosmetics(ids: number[]) {
  const chunks = useMemo(() => {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += EMOJI_FETCH_CHUNK)
      result.push(unique.slice(i, i + EMOJI_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.cosmetic.getEmoji({ ids: chunk }, { staleTime: Infinity, gcTime: Infinity })
    )
  );

  const emoji = useMemo(() => {
    const map = new Map<number, ResolvedEmoji>();
    for (const query of queries) for (const item of query.data ?? []) map.set(item.id, item);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(',')]);

  return { emoji, isLoading: queries.some((q) => q.isLoading) };
}
