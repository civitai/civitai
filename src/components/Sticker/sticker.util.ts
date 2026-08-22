import { uniqBy } from 'lodash-es';
import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import {
  stickerPricePerUseFromCosmeticData,
  stickerUsesFromCosmeticData,
} from '~/shared/utils/sticker-token';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { STICKER_OFFER_LIMIT } from '~/server/schema/cosmetic.schema';
import type { DraftPurchase } from '~/store/sticker-placement-draft.store';

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

    // One tile per sticker, not per holding: buying a sticker you own adds a
    // row, and each tile would then show the whole balance. Sorted newest-first
    // above, so the survivor is the most recent purchase.
    return uniqBy(resolved, 'id');
  }, [data?.sticker]);

  const bySlug = useMemo(() => {
    const map = new Map<string, ResolvedSticker>();
    for (const item of sticker) if (!map.has(item.slug)) map.set(item.slug, item);
    return map;
  }, [sticker]);

  return { sticker, bySlug, isLoading };
}

/**
 * Buying more uses of a sticker, with the cache work that has to follow it.
 *
 * Shared because there are three surfaces that sell a top-up and one set of
 * caches that go stale when one lands — a caller that forgets an invalidation
 * leaves the picker calling a refilled sticker spent, and offering to sell it
 * again.
 */
export function useBuyStickerUses({
  onSuccess,
  onError,
}: {
  onSuccess?: (result: { quantity: number; remaining: number | null }) => void;
  onError?: (message: string) => void;
} = {}) {
  const queryUtils = trpc.useUtils();

  return trpc.cosmetic.purchaseStickerUses.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        queryUtils.cosmetic.getStickerBalances.invalidate(),
        queryUtils.user.getCosmetics.invalidate(),
      ]);
      onSuccess?.(result);
    },
    onError: (error) => onError?.(error.message),
  });
}

/**
 * Ids split into request-sized chunks, deduped, **in insertion order**.
 *
 * Sorting would make the key independent of the order ids arrive in, which is
 * worth a little when two components ask for the same set differently ordered —
 * and costs a lot to any consumer whose list GROWS. A feed appends older, lower
 * cosmetic ids as it pages; sorted, each one lands mid-list, shifts every chunk
 * boundary after it, changes every chunk key, and refetches the whole surface.
 *
 * Every id lands in exactly one chunk: this is what stops a large collection
 * being silently truncated to the first chunk, which is what the offers query
 * used to do past `STICKER_OFFER_LIMIT`.
 */
export function chunkStickerIds(ids: number[], size: number): number[][] {
  const unique = [...new Set(ids)];
  const result: number[][] = [];
  for (let i = 0; i < unique.length; i += size) result.push(unique.slice(i, i + size));
  return result;
}

/**
 * One request per 100 distinct ids for a whole surface, rather than one per
 * rendered sticker — tRPC request batching sits behind a feature flag that is off
 * by default, so per-component queries would be per-component HTTP requests.
 */
export function useStickerCosmetics(ids: number[]) {
  const chunks = useMemo(
    () => chunkStickerIds(ids, STICKER_FETCH_CHUNK),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.join(',')]
  );

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

/**
 * What a top-up costs, for the stickers actually being asked about.
 *
 * 🔴 TAKES THE IDS IT NEEDS, AND THAT IS THE FIX. This used to fetch an offer
 * for every sticker the placer OWNS, capped at `STICKER_OFFER_LIMIT`, so anyone
 * past that cap got no offer at all for the rest — which renders as "this
 * sticker sells no extra uses", permanently, on the stickers they bought last.
 * The cap existed to keep one query key stable across two callers; there is only
 * one caller now, and it knows the handful of ids it has drafted. Chunked in
 * insertion order for the same reason `useStickerCosmetics` is: a growing list
 * must not reshuffle the keys it already has. The chunk is the endpoint's own
 * maximum, so no collection can outgrow the request.
 *
 * The owned payload's `pricePerUse` is the fallback rather than an afterthought:
 * `purchase` is snapshotted onto a draft when it is created and never
 * recomputed, so a copy made before this query resolves would be stuck
 * permanently on "this sticker sells no extra uses" — a false statement, frozen.
 */
export function useStickerRefill(cosmeticIds: number[]) {
  const currentUser = useCurrentUser();

  // Chunked by the endpoint's OWN maximum, so the request can never be the thing
  // that fails: `getStickerOffers` rejects more ids than this.
  const chunks = useMemo(
    () => chunkStickerIds(cosmeticIds, STICKER_OFFER_LIMIT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cosmeticIds.join(',')]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.cosmetic.getStickerOffers({ ids: chunk }, { enabled: !!currentUser, staleTime: 60_000 })
    )
  );

  return useMemo(() => {
    const byCosmetic = new Map<number, StickerOfferLike>();
    for (const query of queries)
      for (const offer of query.data ?? []) byCosmetic.set(offer.cosmeticId, offer);

    return (cosmeticId: number, ownedPricePerUse?: number) =>
      refillFromOffer(byCosmetic.get(cosmeticId), ownedPricePerUse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(',')]);
}

/** One offer turned into the gate a draft carries. Pure, so it can be asserted. */
export type StickerOfferLike = {
  pricePerUse: number | null;
  creatorUsername: string | null;
  listing: {
    shopItemId: number;
    unitAmount: number;
    acceptsBlue: boolean;
    uses?: number | null;
    viaShopUserId?: number | null;
  } | null;
};

/**
 * The top-up gate for one sticker.
 *
 * 🔴 THE FALLBACK IS THE POINT. `purchase` is snapshotted onto a draft when the
 * draft is created and never recomputed, so a gate built before the offers query
 * resolves is what that draft keeps. Without the owned payload's price standing
 * in, that gate has no price and no pack — which renders as "this sticker sells
 * no extra uses, and it is not on sale right now", a false sentence the placer
 * cannot get out of except by deleting the sticker and starting again.
 *
 * A gate with neither price nor pack is still a real state, not a bug: a sticker
 * sold before per-use pricing existed and since delisted genuinely cannot be
 * topped up. The draft says so instead of offering a button that fails.
 */
export function refillFromOffer(
  offer: StickerOfferLike | undefined,
  ownedPricePerUse?: number
): DraftPurchase {
  const listing = offer?.listing;

  return {
    refill: true,
    perUse: offer?.pricePerUse ?? ownedPricePerUse,
    ...(listing
      ? {
          pack: {
            shopItemId: listing.shopItemId,
            unitAmount: listing.unitAmount,
            acceptsBlue: listing.acceptsBlue,
            uses: listing.uses,
            viaShopUserId: listing.viaShopUserId ?? undefined,
          },
        }
      : {}),
    // `undefined` until the offers land, which shows no attribution rather than
    // crediting the wrong party while it is unknown.
    creatorUsername: offer ? offer.creatorUsername : undefined,
  };
}

/**
 * Uses left of one sticker once every draft of it on the image is paid for.
 *
 * Three states, and collapsing any two of them is a bug someone has already
 * shipped: `null` is unlimited, `undefined` is NOT LOADED YET, and a number is a
 * count. Reading "not loaded" as "has uses" hands out an ungated draft that the
 * server refuses at `assertHasUse`; reading it as "spent" offers to sell a
 * top-up to someone who has plenty.
 *
 * Every draft counts, including the one being copied — each will spend a use
 * when it is bought.
 */
export function remainingStickerUses({
  balances,
  drafts,
  cosmeticId,
}: {
  balances: { cosmeticId: number; remaining: number | null }[] | undefined;
  drafts: { cosmeticId: number }[];
  cosmeticId: number;
}): number | null | undefined {
  if (!balances) return undefined;

  const holding = balances.find((entry) => entry.cosmeticId === cosmeticId);
  // No row at all is not "no uses" — it is a sticker the viewer does not own,
  // which is a different question answered by the draft's own purchase gate.
  if (!holding) return undefined;
  if (holding.remaining == null) return null;

  const drafted = drafts.filter((draft) => draft.cosmeticId === cosmeticId).length;
  return Math.max(holding.remaining - drafted, 0);
}

/**
 * The gate a copy inherits: the sticker-not-owned-yet one, and nothing else.
 *
 * 🔴 WHAT IS **NOT** HERE IS THE POINT. This used to decide the refill gate too —
 * "you are out of uses, so this copy must be topped up" — and write it onto the
 * copy. That is a fact about the moment the copy was made, not about the copy,
 * and it went stale the instant another draft was deleted: the use came back and
 * the copy carried on asking to be bought for it. Justin found it by using it,
 * twice, because the first fix left this path still writing one.
 *
 * Whether an owned sticker has a use left is now decided across every draft on
 * the image, on every render, by `allocateDraftEntitlements`. Nothing stores it.
 *
 * A sticker that is not owned at all is different: it must be bought before it
 * can be placed, one purchase grants it, and `markPurchased` then frees every
 * draft of it. That is a property of the draft and it travels with the copy.
 */
export function unownedGateFor(source: { purchase?: DraftPurchase }): DraftPurchase | undefined {
  const purchase = source.purchase;
  if (!purchase?.pack || purchase.refill) return undefined;

  return purchase;
}

/**
 * Which drafts on the image are covered by what the placer already has, and
 * which still have to be bought.
 *
 * 🔴 AN ALLOCATION, NOT A SNAPSHOT — and that distinction is the bug Justin
 * found by using it. The gate used to be decided when a draft was CREATED and
 * written onto it: with one use left, the first draft was free to place and the
 * second arrived asking to be bought. Delete the first, and the second kept
 * asking, because the fact that stopped it was frozen into it. The use it was
 * waiting for had been handed back and nothing reassigned it.
 *
 * So entitlement belongs to the SET of drafts, recomputed whenever it changes:
 * `remaining` uses cover the first `remaining` drafts of that sticker in the
 * order they were laid down, and every later one needs a top-up. Remove a
 * covered draft and the next one moves up into the use it left behind.
 *
 * The same rule decides the free placement, and for the same reason: a free
 * placement is once per image, so exactly ONE draft can be the free one. Showing
 * "free" on all of them is an offer three of them cannot keep — and the free one
 * has to move too when the draft holding it is deleted.
 *
 * Creation order rather than selection or position: it is the only order that
 * does not change under the placer's hands, so a sticker does not lose its use
 * because another one was dragged.
 */
export type DraftEntitlement = {
  /** This draft is covered by a use the placer already owns. */
  covered: boolean;
  /** This is the one draft that may take the free placement, if one is on offer. */
  free: boolean;
};

export function allocateDraftEntitlements({
  drafts,
  balances,
  freeAvailable,
  paidDraftIds = [],
}: {
  /** In creation order — the store appends, so `drafts` already is. */
  drafts: { id: string; cosmeticId: number; purchase?: DraftPurchase }[];
  balances: { cosmeticId: number; remaining: number | null }[] | undefined;
  freeAvailable: boolean;
  /** Drafts whose own buy button paid for a use, oldest purchase first. */
  paidDraftIds?: string[];
}): Map<string, DraftEntitlement> {
  const seen = new Map<number, number>();
  const result = new Map<string, DraftEntitlement>();

  /**
   * Drafts that paid for a use come first.
   *
   * 🔴 WITHOUT THIS, BUYING A USE HANDS IT TO A DIFFERENT STICKER. Coverage is
   * assigned in creation order, so pressing "Buy a use" on the SECOND of two
   * gated copies raised the balance and covered the FIRST — the button you paid
   * on did not change, which reads as a failed purchase and invites paying
   * again. Uses are fungible per sticker so no Buzz is lost, but the wrong
   * sticker becomes placeable and the right one keeps asking.
   *
   * Purchase order among themselves, so two purchases resolve in the order they
   * were made rather than by where the drafts happen to sit.
   */
  const ordered = [...drafts].sort((a, b) => {
    const paidA = paidDraftIds.indexOf(a.id);
    const paidB = paidDraftIds.indexOf(b.id);
    if (paidA === paidB) return 0;
    if (paidA < 0) return 1;
    if (paidB < 0) return -1;
    return paidA - paidB;
  });

  for (const draft of ordered) {
    const before = seen.get(draft.cosmeticId) ?? 0;
    seen.set(draft.cosmeticId, before + 1);

    const remaining = balances?.find((entry) => entry.cosmeticId === draft.cosmeticId)?.remaining;

    // Unknown is not zero. No balances yet, or no holding for a sticker being
    // bought outright, both mean this rule has nothing to say — the draft's own
    // stored gate answers instead.
    const covered =
      balances === undefined || remaining === undefined
        ? true
        : remaining === null || before < remaining;

    result.set(draft.id, { covered, free: false });
  }

  /**
   * The free placement goes to the first draft that can actually take it — which
   * is decided AFTER coverage, not before.
   *
   * 🔴 CHOSEN BEFORE COVERAGE, IT LANDED ON A DRAFT THAT COULD NOT USE IT. A
   * spent owned sticker created first won the free slot and then rendered a buy
   * button, because a draft that has to be bought hides the free option — and
   * every other draft was told there was no free offer. The placer had a free
   * placement available and nowhere to spend it.
   *
   * A sticker not owned at all is skipped for the same reason from the other
   * direction: it must be bought before it can be placed, which is not what free
   * means here.
   */
  if (freeAvailable) {
    const freeDraft = drafts.find(
      (draft) => result.get(draft.id)?.covered && (!draft.purchase?.pack || !!draft.purchase.refill)
    );

    if (freeDraft) result.set(freeDraft.id, { ...result.get(freeDraft.id)!, free: true });
  }

  return result;
}

/**
 * Whether a failed purchase can be retried as a NEW intent.
 *
 * 🔴 STRUCTURAL, NOT TEXTUAL — and the first attempt at this was textual, which
 * is why it was wrong. It matched refusal wording, and the server says "This
 * cosmetic is not available", "out of stock", "The price changed to N Buzz" and
 * four others the list never had. A miss locks the placer out of that sticker
 * until they reload, which is the bug releasing the key was meant to fix.
 *
 * A 4xx is the server declining: nothing was charged, so the next press is a new
 * intent and needs a new key. Anything else — a 5xx, a timeout, no response at
 * all — might have gone through, and reissuing the key there is how one purchase
 * becomes two. Unknown holds the key, always.
 *
 * `data.httpStatus` comes from tRPC's error shape, which this repo's
 * `errorFormatter` passes through untouched. A network failure has no `data` and
 * therefore holds, which is the point.
 */
export function purchaseCanBeRetriedFresh(error: unknown): boolean {
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;

  // 408 is the one 4xx that does not mean "nothing happened": a request timed
  // out at an edge or proxy may still have been forwarded and processed.
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}
