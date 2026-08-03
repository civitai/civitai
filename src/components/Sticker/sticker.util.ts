import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import { trpc } from '~/utils/trpc';

/**
 * A sticker the author may insert, with the balance to show beside it.
 * `null` = unlimited, `undefined` = balances haven't loaded yet. The two must
 * stay distinct: defaulting an unloaded balance to null flashes "unlimited".
 */
export type AvailableSticker = ResolvedSticker & { remaining: number | null | undefined };

export type ResolvedSticker = {
  id: number;
  name: string;
  slug: string;
  url: string;
  animated?: boolean;
};

/** Matches the `ids` cap on `getStickerCosmeticsSchema`. */
const STICKER_FETCH_CHUNK = 100;

const obtainedTime = (value?: Date) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? 0 : time;
};

/**
 * Owned sticker, most-recently-obtained first — newest purchases surface at the
 * top of the picker. Slugs are unique per cosmetic, so `bySlug` can't collide;
 * first-wins is just how the map is built, not a tie-break rule.
 */
export function useOwnedSticker() {
  const { data, isLoading } = useQueryUserCosmetics();

  const sticker = useMemo(() => {
    const owned = data?.sticker ?? [];
    return owned
      .map(({ id, name, data: stickerData, obtainedAt }) => ({
        id,
        name,
        slug: stickerData?.slug,
        url: stickerData?.url,
        animated: stickerData?.animated,
        obtainedAt,
      }))
      .filter((x) => !!x.slug && !!x.url)
      .sort((a, b) => obtainedTime(b.obtainedAt) - obtainedTime(a.obtainedAt));
  }, [data?.sticker]);

  const bySlug = useMemo(() => {
    const map = new Map<string, ResolvedSticker>();
    for (const item of sticker) if (!map.has(item.slug)) map.set(item.slug, item);
    return map;
  }, [sticker]);

  return { sticker, bySlug, isLoading };
}

/**
 * One request per 100 distinct ids for a whole surface, rather than one per
 * rendered sticker — tRPC request batching sits behind a feature flag that is off
 * by default, so per-component queries would be per-component HTTP requests.
 */
export function useStickerCosmetics(ids: number[]) {
  const chunks = useMemo(() => {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += STICKER_FETCH_CHUNK)
      result.push(unique.slice(i, i + STICKER_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.cosmetic.getSticker({ ids: chunk }, { staleTime: Infinity, gcTime: Infinity })
    )
  );

  const sticker = useMemo(() => {
    const map = new Map<number, ResolvedSticker>();
    for (const query of queries) for (const item of query.data ?? []) map.set(item.id, item);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(',')]);

  return { sticker, isLoading: queries.some((q) => q.isLoading) };
}
