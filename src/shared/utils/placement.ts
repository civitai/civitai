import type { MembershipTier } from '~/shared/utils/subscription-tokens';

/**
 * A creator-owned space someone pays to occupy. Stickers on an image and the
 * remix gallery are two instances of it, and nothing in this module knows which
 * is which — a surface supplies its own payload and render, and reaches this
 * layer only through the table below.
 */
export type PlacementSurface = 'sticker' | 'remixGallery';

/** Where a space can be configured. Resolution runs image -> post -> account. */
export type PlacementSpaceEntity = 'image' | 'post' | 'user';

export type PlacementSpaceMode =
  /** Nothing may be placed. */
  | 'off'
  /** Placements arrive pending; the owner approves or declines. */
  | 'review'
  /** Placements go live on payment. */
  | 'auto';

export type PlacementStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'removed';

/**
 * Who removed a placement, stored alongside `status: 'removed'`.
 *
 * The removals have different money outcomes — an owner removing an
 * auto-approved placement refunds in full, a moderator removing an abusive one
 * refunds nothing, and a cosmetic takedown refunds in full because the abuse was
 * the artwork's maker's rather than the placer's — so `removed` alone cannot
 * tell a reconcile or a retry which one happened.
 *
 * The column is TEXT, not a database enum, so a new value here is a code change
 * and not a migration.
 */
export type PlacementRemovedBy = 'owner' | 'moderator' | 'cosmeticTakedown';

/**
 * Every movement of money a placement can make, one row each in the ledger.
 *
 * The escrow is taken as **two holds** — the decline fee and the principal — so
 * that every release is a whole-hold operation.
 *
 * Two properties follow, and both are the point rather than side effects:
 *
 * 1. Settlement never pays back through the placer's wallet. Refunding in full
 *    and then charging the fee would hand them custody of money they owe, and a
 *    placer can *make* that window happen by racing a spend against the refund —
 *    the fee then fails for insufficient funds and declines become free.
 * 2. The placer's money always returns through a real refund of a real hold, so
 *    the Buzz service restores the exact yellow/green mix it drew from. Nothing
 *    here reconstructs that mix by arithmetic of ours, which would be a rule we
 *    invented and would have to keep correct forever.
 *
 * The cost: the decline fee is fixed when the placement is made, not when it is
 * declined. Deliberate — the fee is the price of the owner's attention, and a
 * price shouldn't move after you've paid it.
 */
export type PlacementTransactionKind =
  | 'holdFee'
  | 'holdPrincipal'
  | 'feeToOwner'
  | 'principalToPlacer'
  | 'feeToPlacer'
  | 'toOwner'
  | 'toSeller'
  | 'toPlatform'
  | 'forfeit';

export const PLACEMENT_HOLD_KINDS = [
  'holdFee',
  'holdPrincipal',
] as const satisfies readonly PlacementTransactionKind[];

/**
 * Derived from the row, never from the clock.
 *
 * Both existing escrow precedents build `…-${Date.now()}` prefixes, so a retry
 * presents a *different* id and walks past the Buzz service's own dedupe — which
 * the challenge payouts rely on deliberately (`challenge-prize.ts`). A
 * row-derived id makes that dedupe a real second line behind the ledger's
 * unique constraint.
 */
export const placementTransactionId = (placementId: number, kind: PlacementTransactionKind) =>
  `placement-${placementId}-${kind}`;

/**
 * Everything that varies per surface, in one table — the shape v1's
 * `STICKER_SURFACES` earned. **A surface absent from this table is denied
 * everywhere**, which is the property the table exists for; adding one must be
 * a deliberate edit here rather than a string that happens to reach a query.
 */
export const PLACEMENT_SURFACES = {
  sticker: {
    label: 'stickers',
    targets: ['image'],
    // `defaultMode` and `defaultPrice` are one decision, not two. An open space
    // with no price is the state `setPlacementSpace` refuses to write, so a mode
    // above `off` here without a price would make the default unreachable by
    // hand and invisible in the UI.
    defaultMode: 'review',
    defaultPrice: 100,
    trackMinPrice: 50,
    serverMinPrice: 50,
    defaultDeclineFeeRate: 0.3,
    defaultSellerShare: 0,
    // The whole payment reaches the space owner, and the place button says so.
    // Changing this makes that copy false — change both or neither.
    defaultPlatformShare: 0,
    expiryHours: 48,
    defaultFreeSlots: 1,
    maxPendingPerOwner: 10,
    allowedModes: ['off', 'review', 'auto'],
  },
  remixGallery: {
    label: 'remix galleries',
    targets: ['image'],
    // On for everyone at launch. Turning a gallery off is an opt-OUT, done
    // through the same three-level space settings, rather than something a
    // creator has to find and enable first.
    //
    // Review, never `auto`: a gallery places arbitrary user-uploaded media on
    // someone else's page, so every entry passes its owner. `allowedModes`
    // refuses `auto` for this surface where the value is stored.
    defaultMode: 'review',
    // Same decision as the mode, per the note above — a default mode without a
    // default price would put an inviting gallery on every image and refuse
    // every submission to it, because submission refuses an unpriced space.
    //
    // Deliberately above `serverMinPrice`: the floor is the spam gate and the
    // default is what the platform thinks a gallery slot is worth. A creator can
    // price down to 50, but nobody lands there by doing nothing.
    defaultPrice: 100,
    trackMinPrice: 50,
    serverMinPrice: 50,
    defaultDeclineFeeRate: 0.3,
    defaultSellerShare: 0,
    // Zero for launch: the whole payment reaches the creator. Unlike the sticker
    // surface, no copy hardcodes that — the submit card reads `ownerShare` and
    // says "all proceeds" only while this is 0, so raising it changes the
    // wording rather than making it false.
    //
    // Tunable at runtime without a deploy, via the `placement:config` KeyValue
    // row: `approvalShares.remixGallery.platform`.
    defaultPlatformShare: 0,
    expiryHours: 48,
    defaultFreeSlots: 1,
    maxPendingPerOwner: 10,
    // Never `auto`: a gallery places arbitrary user-uploaded media on someone
    // else's page, so every entry passes its owner.
    allowedModes: ['off', 'review'],
  },
} as const satisfies Record<
  PlacementSurface,
  {
    label: string;
    targets: readonly PlacementSpaceEntity[];
    defaultMode: PlacementSpaceMode;
    defaultPrice: number | null;
    /** The bottom of the price slider's track. Presentation only. */
    trackMinPrice: number;
    /**
     * The lowest price the server will accept a creator moving to. A real
     * refusal, not the bottom of a control — for `remixGallery` nothing verifies
     * a submission is genuinely a remix, so the price is the only spam gate the
     * surface has and a gallery set to 1 Buzz is the hole.
     *
     * Separate from `trackMinPrice` because the two answer different questions
     * and stickers already answer them differently: its slider starts at 50
     * while prices below that remain chargeable.
     */
    serverMinPrice: number;
    defaultDeclineFeeRate: number;
    defaultSellerShare: number;
    defaultPlatformShare: number;
    expiryHours: number;
    /**
     * How many free placements a space accepts when its owner has never chosen.
     *
     * `1` rather than `0` because free capacity is opt-OUT, the same decision the
     * gallery's `defaultMode` records: a creator who never opens these settings
     * takes one free placement, which is what makes the habit reachable at all.
     * It is still ceilinged by the score/tier cap, so the bottom band's range of
     * 0-1 makes this both the default and the maximum for a new creator.
     */
    defaultFreeSlots: number;
    /**
     * How many pending placements one placer may have waiting on one owner.
     *
     * A cap on a review queue an owner can work through, not a spam gate — the
     * owner's remedy for the rest is block, which declines all of them.
     *
     * In the table because three call sites enforce it: both paid creation paths
     * and the free one. It was two constants of the same value in two services
     * before the free path needed a third.
     */
    maxPendingPerOwner: number;
    /**
     * Modes this surface may actually be in. A mode outside this list is refused
     * where it is stored AND where it is acted on — a row written before a rule
     * existed still reads back, and a listing that filters is not a mutation that
     * refuses.
     */
    allowedModes: readonly PlacementSpaceMode[];
  }
>;

export const placementSurfaces = Object.keys(PLACEMENT_SURFACES) as PlacementSurface[];

export const isPlacementSurface = (surface: string): surface is PlacementSurface =>
  surface in PLACEMENT_SURFACES;

export const surfaceAcceptsTarget = (surface: PlacementSurface, target: string) =>
  (PLACEMENT_SURFACES[surface].targets as readonly string[]).includes(target);

/**
 * Read the copy from the table so a surface that isn't listed cannot be named
 * in the UI. v1's uses tooltip promised "articles", which were deliberately not
 * a sticker surface; deriving the wording is what makes that unsayable.
 */
export const placementSurfaceLabel = (surface: PlacementSurface) =>
  PLACEMENT_SURFACES[surface].label;

// ---------------------------------------------------------------------------
// Review queues
// ---------------------------------------------------------------------------

/** How many pending placements one page of a review queue carries. */
export const PLACEMENT_QUEUE_PAGE_SIZE = 50;

export type PlacementQueueCursor = { createdAt: Date; id: number };

export const encodePlacementQueueCursor = (row: PlacementQueueCursor) =>
  `${row.createdAt.getTime()}:${row.id}`;

/**
 * A malformed cursor becomes a fresh first page rather than reaching a query.
 *
 * `Number.isSafeInteger`, not `isFinite`: `1e21` is finite and makes an Invalid
 * Date (the max time value is 8.64e15), and `1.5` is finite and goes to an `INT`
 * column as a fraction. Both are hand-crafted-cursor-only, and both are a 500
 * rather than anything worse — but the guard is here to say a cursor never
 * reaches the database unparsed, so it has to actually do that.
 */
export function parsePlacementQueueCursor(cursor?: string | null): PlacementQueueCursor | null {
  if (!cursor) return null;

  const parts = cursor.split(':');
  // Length AND emptiness: `''.split(':')` is `['', '']` and `Number('')` is 0,
  // so `':'` would otherwise pass every check below and reach the query as a
  // keyset from 1970 — harmless, and a counterexample to what this says it does.
  if (parts.length !== 2 || parts.some((part) => !part.length)) return null;

  const [createdAt, id] = parts.map(Number);
  if (![createdAt, id].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  if (createdAt > MAX_CURSOR_TIME) return null;

  return { createdAt: new Date(createdAt), id };
}

/** ECMAScript's max time value. Past it, `new Date` is an Invalid Date. */
const MAX_CURSOR_TIME = 8.64e15;

/**
 * Where the last page stopped, as a keyset rather than an offset.
 *
 * Both columns the queues order on, in the same order and direction. `createdAt`
 * alone is not unique — two placements made in the same millisecond would either
 * repeat across pages or be stepped over, and an entry stepped over is escrow
 * nobody ever reviews, which is the failure this paging exists to end.
 *
 * An offset would have the same hole for a different reason: acting on a
 * placement takes it out of the queue, so page two of an offset walk skips as
 * many entries as the owner just approved.
 */
export const placementQueueKeyset = (cursor: PlacementQueueCursor | null) =>
  cursor
    ? {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      }
    : {};

// ---------------------------------------------------------------------------
// Space resolution
// ---------------------------------------------------------------------------

/**
 * Settings a surface owns and the foundation only carries. Sticker placement
 * keeps a max size in here; a remix gallery will keep something else. Nothing in
 * this layer reads inside it.
 */
export type PlacementSpaceSettings = Record<string, unknown>;

export type PlacementSpaceSetting = {
  mode: PlacementSpaceMode;
  price: number | null;
  /**
   * How many free placements this space accepts. `0` is a real answer — the
   * creator taking none — which is why this replaces an on/off toggle rather
   * than sitting beside one, and why `null` has to mean "unset" instead.
   *
   * A column rather than a key in `settings`. Both surfaces have the same
   * concept and this layer reads it: `settings` is documented as surface-owned
   * and never read here, so putting it there would either break that or force
   * each surface to reimplement the reservation.
   */
  freeSlots?: number | null;
  settings?: PlacementSpaceSettings;
};

/**
 * Image beats post beats account. A post-level row also covers images added to
 * the post later, which is why the levels inherit rather than the post toggle
 * writing a row per image.
 *
 * `price` resolves independently of `mode`: an owner who priced at the account
 * level and only flipped a single image on should not lose their price.
 */
export function resolvePlacementSpace(
  surface: PlacementSurface,
  levels: {
    image?: PlacementSpaceSetting;
    post?: PlacementSpaceSetting;
    user?: PlacementSpaceSetting;
  }
  // `freeSlots` narrowed to a number: this is the ONE place the surface default
  // is applied, so callers read it rather than defaulting again. `price` is
  // nullable here for a real reason — an unpriced space must not be charged for
  // — where an unset slot count has an unambiguous answer.
): PlacementSpaceSetting & { freeSlots: number } {
  const ordered = [levels.image, levels.post, levels.user];
  return {
    mode:
      ordered.find((level) => level?.mode !== undefined)?.mode ??
      PLACEMENT_SURFACES[surface].defaultMode,
    price:
      ordered.find((level) => level?.price != null)?.price ??
      PLACEMENT_SURFACES[surface].defaultPrice,
    // Independently of `mode` and of `price`, for the same reason they are
    // independent of each other: an owner who set their free capacity once, at
    // the account level, should keep it on an image they later reprice.
    freeSlots:
      ordered.find((level) => level?.freeSlots != null)?.freeSlots ??
      PLACEMENT_SURFACES[surface].defaultFreeSlots,
    // Merged per key, most specific last, rather than taking the first level
    // that has any settings at all: an owner who set a max size on their account
    // and something unrelated on one image should keep both.
    settings: Object.assign(
      {},
      levels.user?.settings,
      levels.post?.settings,
      levels.image?.settings
    ),
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PlacementPriceTier = { minScore: number; caps: Record<PriceCapTier, number> };
type PriceCapTier = 'free' | MembershipTier;

/**
 * What a creator may charge, capped by creator score and membership tier. The
 * creator sets the price; this only ceilings it.
 *
 * ⚠️ The cap values are placeholders pending a product decision; the 10k
 * threshold on band 2 is decided and published. The shape is the
 * commitment: read at request time, overridable through `KeyValue` without a
 * deploy, and never written to a placement row.
 */
export const PLACEMENT_PRICE_CAP_TIERS: PlacementPriceTier[] = [
  { minScore: 0, caps: { free: 100, bronze: 200, silver: 300, gold: 500 } },
  { minScore: 10_000, caps: { free: 250, bronze: 500, silver: 750, gold: 1_000 } },
  { minScore: 25_000, caps: { free: 500, bronze: 1_000, silver: 1_500, gold: 2_500 } },
  { minScore: 100_000, caps: { free: 1_000, bronze: 2_000, silver: 3_000, gold: 5_000 } },
];

/**
 * The absolute lower bound on a charge, below which a price is nonsense rather
 * than cheap. A surface's own floor is `serverMinPrice`, which is the one that
 * refuses a creator's price — this only stops the effective price going
 * negative when a cap is misconfigured.
 */
export const PLACEMENT_MIN_PRICE = 0;

/**
 * The price control's granularity. Global on purpose — the track floor moved to
 * the surface table because stickers and galleries may want different ones, and
 * nobody has asked for two step sizes.
 *
 * ⚠️ A surface whose `trackMinPrice` is not a multiple of this puts the bottom
 * of its own track off-grid, the same way an operator cap does at the top.
 */
export const PLACEMENT_PRICE_STEP = 10;

/**
 * The bounds of the price control: a fixed grid of `[trackMinPrice, cap]` in `step`
 * increments, independent of what is stored.
 *
 * Widening the track to swallow the stored price was worse than the problem.
 * Every commit refetches the row and recomputes, so the floor climbed one drag
 * at a time — 10 to 55 leaves the floor at 50 and 10 is gone for good. And a
 * stored 67 sat *between* steps, so the track claimed a value the grid could
 * not land on and the first nudge silently rounded it away.
 *
 * So the slider owns `[trackMinPrice, cap]` and nothing else. A price outside that
 * grid is preserved until the creator moves the control, and the UI says what
 * it is rather than pretending the slider can return to it.
 */
/**
 * What to say under the price slider about a price it cannot show.
 *
 * Shared because both controls said the over-cap and off-grid cases in
 * byte-identical words and derived them from byte-identical arithmetic. Only
 * the no-price case genuinely differs between them — "the platform default" at
 * the account level, "the level above" below it — so that one stays with the
 * caller.
 *
 * Returns `null` while the cap is unknown, which is the important part: the
 * track falls back to the surface default without one, so any price above it
 * reads as off-grid. Speaking then tells every creator who charges more than
 * the default that their price is about to be rounded, on every page load,
 * before correcting itself.
 */
export function placementPriceCaption(
  surface: PlacementSurface,
  price: number,
  cap: number | null,
  /**
   * Who pays, in the caller's words. Stickers are placed and galleries are
   * submitted to, and a caption that calls a remix submitter a "placer" reads
   * as another feature's copy leaking in. Parameterised rather than derived
   * from `label`, which names the surface and not the person.
   */
  payer = 'Placers'
): { text: string; warning: boolean } | null {
  if (cap == null) return null;

  // The amount and nothing else. It sits on the slider's own mark row, between
  // labels pinned left and right, so a second clause is not a wordier caption —
  // it is one that wraps into them. The explanations it used to carry (the cap,
  // the grid) live in the alert below, which has room for them.
  //
  // A price over the cap quotes the cap, because that is what a placer is
  // charged; the colour is what says something is off, and it needs no words.
  const track = placementPriceTrack(surface, cap);
  return {
    text: `${payer} pay ${Math.min(price, cap)} Buzz`,
    warning: price > cap || !onPlacementPriceGrid(price, track),
  };
}

export function placementPriceTrack(surface: PlacementSurface, cap: number | null) {
  const { trackMinPrice: min, defaultPrice } = PLACEMENT_SURFACES[surface];
  const ceiling = cap ?? defaultPrice ?? min;
  // Snapped down to the grid, so the top of the track is a value the slider can
  // actually land on: an operator cap of 333 would otherwise sit between steps
  // and the thumb could never reach the end of its own track. Down rather than
  // up, because up would offer a price above the cap.
  const steps = Math.floor((ceiling - min) / PLACEMENT_PRICE_STEP);
  // A cap at or below the floor would give a zero-width track, which is a
  // division by zero inside the slider rather than a disabled control.
  return { min, max: min + Math.max(steps, 1) * PLACEMENT_PRICE_STEP };
}

/**
 * Whether a cap leaves room for a choice. Below one step above the surface's
 * floor every position on the slider resolves to the same charge once the
 * server clamps, so the control would be asking a question with one answer.
 */
export const placementPriceUsable = (surface: PlacementSurface, cap: number | null) =>
  cap == null || cap >= PLACEMENT_SURFACES[surface].trackMinPrice + PLACEMENT_PRICE_STEP;

/** Whether the slider can land on this price exactly, or would round it away. */
export const onPlacementPriceGrid = (price: number, track: { min: number; max: number }) =>
  price >= track.min && price <= track.max && (price - track.min) % PLACEMENT_PRICE_STEP === 0;

export function placementPriceCap(
  score: number,
  tier: PriceCapTier,
  tiers: PlacementPriceTier[] = PLACEMENT_PRICE_CAP_TIERS
) {
  const usable = Number.isFinite(score) ? Math.max(score, 0) : 0;
  const band = [...tiers]
    .sort((a, b) => a.minScore - b.minScore)
    .reduce<PlacementPriceTier | null>(
      (best, candidate) => (usable >= candidate.minScore ? candidate : best),
      null
    );
  return band?.caps[tier] ?? 0;
}

/**
 * The effective price is `min(set, cap)` computed here at read. Storing it would
 * go stale the moment a membership lapses or a score moves, with nothing failing
 * to say so.
 *
 * An unset price is `null`, not the cap. The creator sets the price and the cap
 * only ceilings it, so defaulting an unpriced space to its maximum inverts that
 * — callers must decide what an unpriced space does rather than charge for one.
 */
export const effectivePlacementPrice = (setPrice: number | null, cap: number) =>
  setPrice == null ? null : Math.max(Math.min(setPrice, cap), PLACEMENT_MIN_PRICE);

// ---------------------------------------------------------------------------
// Free capacity
// ---------------------------------------------------------------------------

/**
 * How many free placements a creator may accept, capped by creator score and
 * membership tier.
 *
 * Deliberately the same table shape, the same resolver (`placementPriceCap`) and
 * the same `placement:config` override as the price caps above — this is the
 * same idea applied to a different number, and a second mechanism for it would
 * be two things to keep in agreement.
 *
 * The bottom band is 0-1: a brand-new creator takes one free placement, which is
 * also `defaultFreeSlots`, so the default and the maximum coincide until they
 * earn room to raise it. The top is 10, at gold on the highest score band.
 *
 * ⚠️ The middle bands are a judgement, not a measurement. The shape is the
 * commitment: read at request time, overridable without a deploy, never written
 * to a space or a placement row.
 */
export const PLACEMENT_FREE_SLOT_CAP_TIERS: PlacementPriceTier[] = [
  { minScore: 0, caps: { free: 1, bronze: 2, silver: 3, gold: 4 } },
  { minScore: 10_000, caps: { free: 2, bronze: 3, silver: 4, gold: 6 } },
  { minScore: 25_000, caps: { free: 3, bronze: 4, silver: 6, gold: 8 } },
  { minScore: 100_000, caps: { free: 4, bronze: 6, silver: 8, gold: 10 } },
];

/**
 * The most free placements this creator may accept on one space.
 *
 * A thin naming of `placementPriceCap` over the free-slot table, not a second
 * resolver: the band-picking rules (highest band at or below the score, unknown
 * tier reads as free, a table with no zero band is unusable) are the same rules,
 * and two copies of them would be free to drift.
 */
export const placementFreeSlotCap = (
  score: number,
  tier: PriceCapTier,
  tiers: PlacementPriceTier[] = PLACEMENT_FREE_SLOT_CAP_TIERS
) => placementPriceCap(score, tier, tiers);

/**
 * What a space actually accepts, computed at read like the effective price.
 *
 * Clamping only. Defaulting an unset count belongs to `resolvePlacementSpace`
 * and happens there once — this used to re-apply it, which had one read path
 * defaulting three times with two of them unreachable.
 *
 * The floor is not decoration: a misconfigured cap must not let `cap - reserved`
 * hand out capacity nobody set.
 */
export const effectiveFreeSlots = (setSlots: number, cap: number) =>
  Math.max(Math.min(setSlots, cap), 0);

/**
 * How many free placements one placer may make in a UTC day, across every
 * surface. The scarcity is the product: an unbounded free tier is a spam tier,
 * and the people it costs are the creators who then close their spaces.
 */
export const FREE_PLACEMENTS_PER_DAY = 1;

/** Milliseconds in a UTC day. Unix time has no leap seconds, so this is exact. */
const DAY_MS = 24 * 3_600_000;

/**
 * Midnight UTC for the day containing `at`.
 *
 * UTC rather than the placer's local day, so the allowance cannot be refreshed
 * twice by moving timezone, and so two servers never disagree about which day a
 * placement fell in.
 *
 * **Epoch arithmetic rather than calendar getters, because the calendar version
 * is not testable where it matters.** Written as
 * `Date.UTC(at.getUTCFullYear(), …)`, the one-character slip to
 * `at.getFullYear()` produces a local-day boundary — and on a UTC runner, which
 * is what CI is with no `TZ` pinned, the two are the *same function*. No test can
 * separate them there, so a test claiming to would be asserting a property it
 * cannot fail on. Flooring the epoch has no ambient timezone to read, so there is
 * no such slip to make and the property is structural instead of hoped for.
 */
export const freePlacementDayStart = (at: Date = new Date()) =>
  new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);

/**
 * Statuses that hold a free slot.
 *
 * Pending is in the list and that is the entire point of the feature: without
 * reservation, fifty people submit into four slots and the creator gets a
 * fifty-item review queue, which is what the slider exists to prevent. Everything
 * else — declined, expired, removed — releases the slot, immediately.
 */
export const FREE_SLOT_HOLDING_STATUSES = [
  'pending',
  'approved',
] as const satisfies readonly PlacementStatus[];

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

export type PlacementOutcome =
  | 'approved'
  | 'declined'
  | 'expired'
  | 'removedByOwner'
  | 'removedByModerator'
  | 'removedByCosmeticTakedown';

export type PlacementSplitInput = {
  /** Integer Buzz the placer paid into escrow. */
  amount: number;
  outcome: PlacementOutcome;
  /** Operator-set, per surface. Clamped by `clampDeclineFeeRate` before it gets here. */
  declineFeeRate: number;
  /** Share of an approved placement paid to whoever sold the placed thing. */
  sellerShare: number;
  platformShare: number;
};

export type PlacementSplit = {
  toOwner: number;
  toSeller: number;
  toPlatform: number;
  toPlacer: number;
};

const isNonNegativeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isRate = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Splits what a placer paid, for every release path.
 *
 * The invariant, from Demian: **the total paid out can never exceed what the
 * placer spent.** Every branch here therefore derives one component as the
 * remainder rather than computing all of them, so no combination of rates and
 * rounding can sum past `amount`. It throws on out-of-range input instead of
 * clamping — a bad operator config should stop placements, not quietly mint.
 */
export function splitPlacementPayment(input: PlacementSplitInput): PlacementSplit {
  const { amount, outcome, declineFeeRate, sellerShare, platformShare } = input;

  if (!isNonNegativeInt(amount))
    throw new Error(`placement split: amount must be a non-negative integer, got ${amount}`);
  if (!isRate(declineFeeRate))
    throw new Error(`placement split: declineFeeRate out of range: ${declineFeeRate}`);
  if (!isRate(sellerShare) || !isRate(platformShare))
    throw new Error(
      `placement split: shares out of range: seller=${sellerShare} platform=${platformShare}`
    );
  if (sellerShare + platformShare > 1)
    throw new Error(
      `placement split: seller + platform shares exceed the payment: ${sellerShare} + ${platformShare}`
    );

  const nothing: PlacementSplit = { toOwner: 0, toSeller: 0, toPlatform: 0, toPlacer: 0 };

  switch (outcome) {
    case 'approved': {
      const toSeller = Math.floor(amount * sellerShare);
      const toPlatform = Math.floor(amount * platformShare);
      // Rounding dust lands on the space owner, following the creator shop's
      // convention of rounding in the creator's favour.
      return { ...nothing, toSeller, toPlatform, toOwner: amount - toSeller - toPlatform };
    }
    case 'declined': {
      const toOwner = declineFeeAmount(amount, declineFeeRate);
      return { ...nothing, toOwner, toPlacer: amount - toOwner };
    }
    // Neither cost the owner any attention, so neither pays a fee. Removing an
    // auto-approved placement pays nothing on purpose: a fee there would reward
    // accepting placements, banking the money and sweeping them off later.
    // The cosmetic itself was revoked as abusive, which makes the placer a
    // holder of it rather than the offender — they are refunded for it
    // everywhere else, so forfeiting their escrow here would charge them for the
    // maker's abuse. Its own outcome rather than reusing `removedByOwner`: the
    // money is the same and the record is not, and the record is what a
    // reconcile reads to explain why.
    case 'expired':
    case 'removedByOwner':
    case 'removedByCosmeticTakedown':
      return { ...nothing, toPlacer: amount };
    // Not returned — the placement was abusive. It is forfeit rather than paid
    // to the owner, so a removal no one benefits from stays uninteresting to game.
    case 'removedByModerator':
      return { ...nothing, toPlatform: amount };
    // `outcome` arrives from a schemaless TEXT column, so the switch has to
    // refuse an unknown value rather than fall off the end returning undefined —
    // a caller destructuring the result would pay nobody and swallow it.
    default:
      throw new Error(`placement split: unknown outcome ${JSON.stringify(outcome)}`);
  }
}

/**
 * The stored status back to the outcome that decides the money. `removed` is
 * ambiguous on its own — the two removals refund opposite amounts — so it must
 * be resolved with the actor rather than guessed.
 */
export function placementOutcomeFromStatus(
  status: PlacementStatus,
  removedBy?: PlacementRemovedBy | null
): PlacementOutcome {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'removed':
      if (removedBy === 'owner') return 'removedByOwner';
      if (removedBy === 'moderator') return 'removedByModerator';
      if (removedBy === 'cosmeticTakedown') return 'removedByCosmeticTakedown';
      throw new Error('placement outcome: a removed placement must record who removed it');
    case 'pending':
      throw new Error('placement outcome: a pending placement has no settled outcome');
    default:
      throw new Error(`placement outcome: unknown status ${JSON.stringify(status)}`);
  }
}

/**
 * The fee exists to stop submission spam, so it must not round away to nothing
 * on a cheap placement — at a 5% rate anything under 20⚡ would floor to zero.
 */
export function declineFeeAmount(amount: number, rate: number) {
  if (rate <= 0 || amount <= 0) return 0;
  return Math.min(amount, Math.max(1, Math.floor(amount * rate)));
}

/**
 * A free decline defeats the fee, and a confiscatory one makes declining
 * profitable. Both bounds are enforced here rather than trusting whoever edits
 * the operator config.
 */
export const MIN_DECLINE_FEE_RATE = 0.05;
export const MAX_DECLINE_FEE_RATE = 0.5;

/**
 * The space owner's floor on an approved placement. `splitPlacementPayment`
 * conserves at any shares that sum to 1, including ones that pay the owner
 * nothing — which conserves perfectly and defeats the entire premise that a
 * creator's space is worth something. The floor is structural rather than a
 * convention the call site is trusted to keep.
 */
export const MIN_OWNER_SHARE = 0.5;

export const clampApprovalShares = (
  shares: { seller?: number | null; platform?: number | null },
  fallback: { seller: number; platform: number }
) => {
  const usable = (value: number | null | undefined, spare: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : spare;

  const seller = usable(shares.seller, fallback.seller);
  const platform = usable(shares.platform, fallback.platform);

  return seller + platform > 1 - MIN_OWNER_SHARE ? fallback : { seller, platform };
};

export const clampDeclineFeeRate = (rate: number | null | undefined, fallback: number) => {
  const value = typeof rate === 'number' && Number.isFinite(rate) ? rate : fallback;
  return Math.min(Math.max(value, MIN_DECLINE_FEE_RATE), MAX_DECLINE_FEE_RATE);
};
