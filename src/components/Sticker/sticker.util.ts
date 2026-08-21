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

/**
 * What a sticker's top-up costs, for whoever needs to offer one.
 *
 * 🔴 SHARED BECAUSE THE KEY HAS TO BE. Two surfaces ask this — the tray, when a
 * spent sticker is dragged out, and the draft layer, when a spent sticker is
 * duplicated — and the second one keyed its query on the DRAFTED ids while the
 * tray keys on the OWNED ids. Different arrays are different cache entries, so
 * what looked like a shared read was a second request that refetched every time
 * a draft was laid down. The tray's own comment warns against exactly that
 * derivation; the fix is for both callers to ask the same question.
 *
 * The owned payload's `pricePerUse` is the fallback rather than an afterthought:
 * `purchase` is snapshotted onto a draft when it is created and never
 * recomputed, so a copy made before this query resolves would be stuck
 * permanently on "this sticker sells no extra uses" — a false statement, frozen.
 */
export function useStickerRefill() {
  const currentUser = useCurrentUser();
  const { sticker } = useOwnedSticker();

  // The same ids the tray asks for, in the same order: every owned sticker,
  // newest first, capped where the schema caps. Past the cap the whole query
  // fails zod validation and `offers` stays undefined — silently, for anyone
  // with a large collection.
  const ownedIds = useMemo(
    () => sticker.slice(0, STICKER_OFFER_LIMIT).map((option) => option.id),
    [sticker]
  );

  const { data: offers } = trpc.cosmetic.getStickerOffers.useQuery(
    { ids: ownedIds },
    { enabled: !!currentUser && !!ownedIds.length, staleTime: 60_000 }
  );

  return useMemo(() => {
    const byCosmetic = new Map(offers?.map((offer) => [offer.cosmeticId, offer]));

    return (cosmeticId: number, ownedPricePerUse?: number) =>
      refillFromOffer(byCosmetic.get(cosmeticId), ownedPricePerUse);
  }, [offers]);
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
 * Whether a duplicated draft has to be bought before it can be placed.
 *
 * 🔴 THE MONEY DECISION, LIFTED OUT OF THE COMPONENT SO IT CAN BE TESTED. Every
 * branch below is a case that was live and unasserted while this was an inline
 * closure in the layer, and two of them were wrong.
 *
 * The gate is not copied from the source draft, because it says "this sticker is
 * not bought yet" — a fact about the viewer's inventory at the moment the copy
 * is made, not a property of the draft. But it is not discarded either:
 *
 * - **Not owned at all** (no balance row) — a sticker dragged from the shop and
 *   still unbought. The copy needs the SAME gate, because one purchase grants
 *   the sticker and `markPurchased` then clears every draft of it. Dropping the
 *   gate here was the bug: it produced a Place button the server refuses at
 *   `assertHasUse`, from the one direction the original code did not consider.
 * - **Not loaded yet** — indistinguishable from the above at this layer, and the
 *   honest answer is the same: carry the source's gate rather than invent one.
 *   Guessing "has uses" hands out a draft that cannot be placed; guessing
 *   "spent" offers to sell a top-up to someone with plenty.
 * - **Unlimited, or uses left after every draft** — no gate.
 * - **Spent** — the top-up offer a fresh pickup of a spent sticker would get.
 */
export function duplicateGateFor({
  source,
  drafts,
  balances,
  refillFor,
  ownedPricePerUse,
}: {
  source: { cosmeticId: number; purchase?: DraftPurchase };
  drafts: { cosmeticId: number }[];
  balances: { cosmeticId: number; remaining: number | null }[] | undefined;
  refillFor: (cosmeticId: number, ownedPricePerUse?: number) => DraftPurchase;
  ownedPricePerUse?: number;
}): DraftPurchase | undefined {
  const remaining = remainingStickerUses({ balances, drafts, cosmeticId: source.cosmeticId });

  if (remaining === undefined) return source.purchase;
  if (remaining === null || remaining > 0) return undefined;

  return refillFor(source.cosmeticId, ownedPricePerUse);
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
}: {
  /** In creation order — the store appends, so `drafts` already is. */
  drafts: { id: string; cosmeticId: number; purchase?: DraftPurchase }[];
  balances: { cosmeticId: number; remaining: number | null }[] | undefined;
  freeAvailable: boolean;
}): Map<string, DraftEntitlement> {
  const seen = new Map<number, number>();
  const result = new Map<string, DraftEntitlement>();

  // The free placement goes to the first draft that could actually take it. A
  // draft of a sticker the placer does not own yet cannot: it has to be bought
  // before it can be placed at all, and buying it is not what "free" means here.
  const freeDraft = freeAvailable
    ? drafts.find((draft) => !draft.purchase?.pack || draft.purchase.refill)?.id
    : undefined;

  for (const draft of drafts) {
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

    result.set(draft.id, { covered, free: draft.id === freeDraft });
  }

  return result;
}
