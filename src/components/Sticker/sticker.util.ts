import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import {
  stickerPricePerUseFromCosmeticData,
  stickerUsesFromCosmeticData,
} from '~/shared/utils/sticker-token';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * What buying a sticker gets you, as shop copy: the balance included and what a
 * further use costs after that.
 *
 * A sticker with no `uses` really is unlimited — the purchase grant sets
 * `remaining` from that same field — so it gets a statement rather than a blank.
 * A missing `pricePerUse` is different: the sticker sells no top-ups at all, and
 * there is no honest number to show.
 */
export function stickerPurchaseTerms(data: unknown) {
  const uses = stickerUsesFromCosmeticData(data);
  const pricePerUse = stickerPricePerUseFromCosmeticData(data);

  return {
    usesLabel: uses === null ? 'Unlimited uses' : `${numberWithCommas(uses)} uses included`,
    extraUseLabel:
      pricePerUse === null ? null : `${numberWithCommas(pricePerUse)} Buzz per extra use`,
  };
}

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
  /** What one more use costs. Absent = this sticker doesn't sell top-ups. */
  pricePerUse?: number;
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
    const resolved = owned
      .map(({ id, name, data: stickerData, obtainedAt }) => ({
        id,
        name,
        slug: stickerData?.slug,
        url: stickerData?.url,
        animated: stickerData?.animated,
        pricePerUse: stickerData?.pricePerUse,
        obtainedAt,
      }))
      .filter((x) => !!x.slug && !!x.url)
      .sort((a, b) => obtainedTime(b.obtainedAt) - obtainedTime(a.obtainedAt));

    // One tile per sticker, not per holding. The source is `UserCosmetic` rows,
    // and buying a sticker you already own adds a row rather than replacing one
    // — so a refill used to put a second, identical tile in the picker, and the
    // balance under each was the whole balance, making it read as double what it
    // was. Newest first, so the surviving entry is the most recent purchase.
    const seen = new Set<number>();
    const unique: typeof resolved = [];
    for (const item of resolved) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push(item);
    }
    return unique;
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
    // **Insertion order, not sorted.** Sorting makes a key independent of the
    // order ids arrive in, which is worth a little when two components ask for
    // the same set differently ordered — and costs a lot to the one consumer
    // whose list GROWS. A feed appends older, lower cosmetic ids as it pages;
    // sorted, each one lands mid-list, shifts every chunk boundary after it,
    // changes every chunk key, and refetches the whole surface's artwork. Below
    // 100 distinct stickers there is one chunk and no boundary to shift, so this
    // only bites the case that matters: a long scroll once stickers are popular.
    const unique = [...new Set(ids)];
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += STICKER_FETCH_CHUNK)
      result.push(unique.slice(i, i + STICKER_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      // Sticker artwork is immutable once published, so it never goes stale. It
      // is not kept forever, though: a growing list mints a new key per page and
      // the superseded ones are all subsets of the newest, so `gcTime: Infinity`
      // would accumulate every intermediate list for the length of a session —
      // the same never-leaves shape this feature keeps producing, in client
      // memory this time.
      t.cosmetic.getSticker({ ids: chunk }, { staleTime: Infinity, gcTime: 10 * 60_000 })
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
