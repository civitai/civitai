import type { Prisma } from '@prisma/client';
import {
  countPlacements,
  getChapterPlacementTarget,
  getImagePlacementTarget,
  getModelPlacementTarget,
  listPlacementSpacesFor,
} from '@civitai/db-queries/placement';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import {
  countFreeTier,
  reservedFreeSlotsWhere,
} from '~/server/services/placement-count-predicates';
import { getPlacementConfig, placementPriceRange } from '~/server/services/placement.service';
import { throwBadRequestError, throwAuthorizationError } from '~/server/utils/errorHandling';
import type {
  PlacementSpaceEntity,
  PlacementSpaceMode,
  PlacementSpaceSetting,
  PlacementSpaceSettings,
  PlacementSurface,
  PlacementTargetType,
} from '~/shared/utils/placement';
import type { StickerMediaType } from '~/shared/utils/sticker-placement';
import { stickerMediaTypeOf, stickerMediaTypes } from '~/shared/utils/sticker-placement';
import { isAnswerableParentChapter, STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import {
  effectiveFreeSlots,
  declineFeeAmount,
  HOST_DECLINE_FEE_SETTING,
  hostDeclineFeePercentRefusal,
  isDeclineFeeHostAdjustable,
  resolveHostDeclineFeePercent,
  effectivePlacementPrice,
  PLACEMENT_SURFACES,
  placementSurfaceLabel,
  resolvePlacementSpace,
  surfaceAcceptsTarget,
} from '~/shared/utils/placement';

/**
 * Who owns a target and where it sits in the cascade.
 *
 * Read from the primary. This decides whether a mutation is allowed and what it
 * charges, and a replica that is seconds behind an owner turning their space off
 * would let a placement through against a decision already made.
 */
async function resolveImageTarget(imageId: number) {
  // The username rides along on the lookup that was already happening. It is shown to the placer,
  // so a second query keyed on the id this one returns would be a round trip for a string this row
  // can reach in the same hop.
  return imageTargetFrom(
    await getImagePlacementTarget((await loadKyselyDb()).kyselyWrite, imageId)
  );
}

function imageTargetFrom(
  row: Pick<ImageTargetRow, 'userId' | 'postId' | 'type' | 'username'> | undefined
) {
  if (!row) throw throwBadRequestError('placement: that image no longer exists');
  return {
    ownerId: row.userId,
    postId: row.postId,
    mediaType: stickerMediaTypeOf(row.type),
    ownerUsername: row.username ?? null,
  };
}

type ImageTargetRow = NonNullable<Awaited<ReturnType<typeof getImagePlacementTarget>>>;

/** A model's space is configured on its owner's account only; there is no model or post level. */
async function resolveModelTarget(modelId: number) {
  return modelTargetFrom(
    await getModelPlacementTarget((await loadKyselyDb()).kyselyWrite, modelId)
  );
}

function modelTargetFrom(row: { userId: number; username: string | null } | undefined) {
  if (!row) throw throwBadRequestError('placement: that model no longer exists');
  return { ownerId: row.userId, postId: null, ownerUsername: row.username ?? null };
}

/**
 * A post target is a storyline chapter: a continuation sits on the chapter post it continues.
 *
 * 🔴 **The owner is the storyline's creator, not the chapter post's author.**
 * Chapters can be written by collaborators, and a continuation of one still
 * goes to the storyline creator's queue and is priced by their space and
 * their cap. Taking the post's author would hand a collaborator someone else's
 * review queue and earnings.
 *
 * Its space cascades storyline -> the creator's account -> surface default,
 * with no post or image level.
 */
async function readChapterTarget(postId: number) {
  const row = await getChapterPlacementTarget((await loadKyselyDb()).kyselyWrite, postId);
  return row
    ? {
        removedAt: row.removedAt,
        storyline: {
          id: row.storylineId,
          userId: row.storylineUserId,
          status: row.storylineStatus,
          tosViolation: row.storylineTosViolation,
          user: { username: row.username },
        },
      }
    : null;
}

async function resolveChapterTarget(postId: number) {
  const chapter = await readChapterTarget(postId);
  // A taken-down storyline or a removed chapter is not a target at all:
  // refusing here, where the space is resolved, keeps every read of it (the
  // contributor's price, the submit) from showing it as open.
  if (!chapter || !isAnswerableParentChapter(chapter))
    throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

  return {
    ownerId: chapter.storyline.userId,
    postId: null,
    storylineId: chapter.storyline.id,
    complete: chapter.storyline.status === 'Complete',
    ownerUsername: chapter.storyline.user?.username ?? null,
  };
}

type ResolvedTarget = {
  ownerId: number;
  postId: number | null;
  storylineId?: number;
  complete?: boolean;
  /** Only an image target has one; the account's media-type setting reads it. */
  mediaType?: StickerMediaType;
  ownerUsername: string | null;
};

const resolveTarget = (
  targetType: PlacementTargetType,
  targetId: number
): Promise<ResolvedTarget> => {
  if (targetType === 'model') return resolveModelTarget(targetId);
  if (targetType === 'post') return resolveChapterTarget(targetId);
  return resolveImageTarget(targetId);
};

export type ResolvedPlacementSpace = {
  ownerId: number;
  /** The storyline a chapter target belongs to; absent for every other target. */
  storylineId?: number;
  /**
   * Who the placer is paying, by name.
   *
   * Carried because "the creator" is ambiguous at the point it is read: the
   * placer is looking at someone else's image with someone else's sticker on
   * it, and both have a creator. `null` for a deleted or nameless account,
   * where the caller falls back to the unnamed wording rather than showing a
   * blank.
   */
  ownerUsername: string | null;
  /** Whether an image target is a still or a video; absent for other targets. */
  mediaType?: StickerMediaType;
  mode: PlacementSpaceMode;
  /** What the owner asks. `null` when they have never set one. */
  setPrice: number | null;
  /** `min(setPrice, cap)`, computed here and never stored. `null` when unpriced. */
  price: number | null;
  cap: number;
  /**
   * The share of an approved payment the space owner keeps, 0-1.
   *
   * Carried so the placer can be told where their Buzz goes without the UI
   * hardcoding it. The shares are operator-tunable at runtime, so a string
   * compiled against today's split is a claim about money that can silently
   * stop being true.
   */
  ownerShare: number;
  /**
   * What the creator keeps if they decline, in Buzz, at this space's price.
   * Already an amount rather than a rate: the fee floors at 1⚡ so a client
   * multiplying a percentage would be wrong on cheap placements.
   */
  declineFee: number;
  /**
   * The rate that sizes the decline-fee hold when a placement is bought here.
   * The hold is the snapshot: a decline pays what was held, never this.
   */
  declineFeeRate: number;
  /** The host's own setting in whole percent; `null` where the platform fixes the fee. */
  hostDeclineFeePercent: number | null;
  /**
   * The count the cascade resolved, before the cap — the same relationship
   * `setPrice` has to `price`, so a caller can say "you have set 9, we are
   * honouring 2" rather than only showing the smaller number.
   */
  setFreeSlots: number;
  /** `min(setFreeSlots, freeSlotCap)`, computed here and never stored. */
  freeSlots: number;
  freeSlotCap: number;
  /**
   * How many free placements this space will still accept, right now.
   *
   * Never negative. A creator who lowers their slider below what is already
   * reserved is not taking anything back — the placements they already accepted
   * stay — so the space simply accepts nothing further until they release.
   *
   * ⚠️ This is what a caller SHOWS. It is not what a caller may decide on: by the
   * time it is read the count is already stale. The refusal lives in
   * `createFreePlacement`, which re-counts under a lock in the same transaction
   * that inserts.
   */
  freeSlotsRemaining: number;
  /** Surface-owned; this layer carries it without reading inside it. */
  settings: PlacementSpaceSettings;
};

/**
 * How many of a space's free slots are spoken for.
 *
 * Pending counts, and that is the whole feature: a free placement holds its slot
 * from the moment it is made. Without it fifty people submit into four slots and
 * the creator gets a fifty-item review queue — the exact outcome the slider
 * exists to prevent. Declined, expired and removed rows are absent from the
 * status list, so a released slot is claimable by the next caller with no sweep
 * in between.
 *
 * Paid placements are not counted. The two counters are independent, so a
 * fully-booked paid image still shows its free slots as available.
 *
 * The predicate is `reservedFreeSlotsWhere`, which the display path's Kysely count
 * reads too, so the two cannot disagree. Team-waived rows hold no slot.
 */
export const reservedFreeSlots = (
  /**
   * Narrowed to the one model it touches so a transaction client satisfies it.
   * The claim MUST pass its `tx` — counting on any other connection would read
   * outside the lock it just took, and the count would be a listing again.
   */
  client: Pick<typeof dbWrite, 'placement'>,
  target: SpaceTarget
) => countFreeTier((where) => client.placement.count({ where }), reservedFreeSlotsWhere(target));

type SpaceTarget = { surface: PlacementSurface; targetType: PlacementTargetType; targetId: number };

/**
 * `reservedFreeSlots` for display only, off any transaction. The claim's own count stays on
 * `reservedFreeSlots(tx, …)` under its lock.
 */
const displayedReservedFreeSlots = async (target: SpaceTarget) => {
  const db = (await loadKyselyDb()).kyselyRead;
  return countFreeTier((where) => countPlacements(db, where), reservedFreeSlotsWhere(target));
};

/**
 * The space that governs one target, with the cascade already applied.
 *
 * The effective price is computed at read on purpose: a membership lapse or a
 * score change must move the cap immediately, and a stored effective price goes
 * stale with nothing failing to say so.
 */
export function resolvePlacementSpaceFor(input: SpaceTarget): Promise<ResolvedPlacementSpace> {
  return resolveSpaceWith(input, primaryReads);
}

type SpaceRow = Awaited<ReturnType<typeof listPlacementSpacesFor>>[number];
type SpaceLevel = { entityType: string; entityId: number };

/**
 * The two row reads the cascade is built from. Everything else `resolveSpaceWith` reads — the
 * price range, the config, the reserved count — is read live on every path, because each is
 * documented above as computed at read and never persisted.
 */
type SpaceReads = {
  target: (targetType: PlacementTargetType, targetId: number) => Promise<ResolvedTarget>;
  rows: (surface: PlacementSurface, levels: SpaceLevel[]) => Promise<SpaceRow[]>;
};

/** From the primary, uncached: what every caller that decides or charges reads. */
const primaryReads: SpaceReads = {
  target: resolveTarget,
  rows: async (surface, levels) =>
    listPlacementSpacesFor((await loadKyselyDb()).kyselyWrite, { surface, levels }),
};

async function resolveSpaceWith(
  { surface, targetType, targetId }: SpaceTarget,
  reads: SpaceReads
): Promise<ResolvedPlacementSpace> {
  if (!surfaceAcceptsTarget(surface, targetType))
    throw throwBadRequestError(`placement: ${surface} cannot be placed on a ${targetType}`);

  const target = { surface, targetType, targetId };
  const { ownerId, postId, storylineId, complete, mediaType, ownerUsername } = await reads.target(
    targetType,
    targetId
  );

  const levels = [
    ...(storylineId ? [{ entityType: 'storyline', entityId: storylineId }] : []),
    ...(targetType === 'image' ? [{ entityType: 'image', entityId: targetId }] : []),
    ...(postId ? [{ entityType: 'post', entityId: postId }] : []),
    { entityType: 'user', entityId: ownerId },
  ];
  const rows = await reads.rows(surface, levels);

  const at = (entityType: PlacementSpaceEntity): PlacementSpaceSetting | undefined => {
    const row = rows.find((candidate) => candidate.entityType === entityType);
    return row
      ? {
          mode: row.mode as PlacementSpaceMode,
          price: row.price,
          freeSlots: row.freeSlots,
          settings: (row.settings ?? {}) as PlacementSpaceSettings,
        }
      : undefined;
  };

  // An account that has switched stickers off for this kind of media is closed at
  // the account level only, so it is the lowest rung of the cascade: a post or an
  // image the owner switched on by hand still accepts them. Sticker-only — the
  // setting lives in the sticker row, and no other surface reads it.
  const account = at('user');
  const mediaClosed =
    surface === 'sticker' &&
    mediaType !== undefined &&
    !stickerMediaTypes(account?.settings).includes(mediaType);

  const resolved = resolvePlacementSpace(surface, {
    storyline: at('storyline'),
    image: at('image'),
    post: at('post'),
    user: mediaClosed && account ? { ...account, mode: 'off' } : account,
  });

  // One read: the price range needs the same row.
  const config = await getPlacementConfig();
  const { max: cap, freeSlotCap } = await placementPriceRange(ownerId, surface, config);
  const shares = config.approvalShares(surface);
  const hostDeclineFeePercent = isDeclineFeeHostAdjustable(surface)
    ? resolveHostDeclineFeePercent(surface, resolved.settings)
    : null;
  const declineFeeRate =
    hostDeclineFeePercent == null ? config.declineFeeRate(surface) : hostDeclineFeePercent / 100;

  // `resolvePlacementSpace` is the one place the surface default is applied, so
  // this reads it rather than defaulting again — the same shape as `setPrice`
  // directly above.
  const setFreeSlots = resolved.freeSlots;
  const freeSlots = effectiveFreeSlots(setFreeSlots, freeSlotCap);
  // The replica, unlike everything above it. The rest of this function decides
  // whether a mutation is allowed and what it charges, which a lagging replica
  // must not answer; `freeSlotsRemaining` is display-only by construction — the
  // claim re-counts under its own lock — and this read is on a public query
  // reached from every image detail view.
  //
  // Skipped when there is no capacity to reserve against. That is rarer than it
  // looks: the default and the bottom band are both 1, so it fires only for a
  // creator who has explicitly closed their slots.
  const reserved = freeSlots > 0 ? await displayedReservedFreeSlots(target) : 0;

  return {
    ownerId,
    ...(storylineId ? { storylineId } : {}),
    ...(mediaType ? { mediaType } : {}),
    ownerUsername,
    // A completed storyline takes no continuations, whatever its space says.
    // Read from the storyline itself rather than trusting Complete to have
    // written the space too, so the two cannot disagree.
    mode: complete ? 'off' : resolved.mode,
    setPrice: resolved.price,
    price: effectivePlacementPrice(resolved.price, cap),
    cap,
    ownerShare: 1 - shares.seller - shares.platform,
    /**
     * What the creator keeps if they decline, in Buzz, at this space's price.
     *
     * Computed here rather than shipped as a rate: the rate is operator-tunable
     * and the floor is not linear — `declineFeeAmount` clamps to a minimum of 1
     * so the fee cannot round away to nothing on a cheap placement — so a client
     * multiplying a percentage would be quietly wrong on exactly the cheap
     * placements the floor exists for. The placer is told an amount because an
     * amount is what leaves their wallet.
     */
    declineFee: declineFeeAmount(effectivePlacementPrice(resolved.price, cap) ?? 0, declineFeeRate),
    declineFeeRate,
    hostDeclineFeePercent,
    setFreeSlots,
    freeSlots,
    freeSlotCap,
    freeSlotsRemaining: Math.max(freeSlots - reserved, 0),
    settings: resolved.settings ?? {},
  };
}

// #region [display read]

/**
 * `resolvePlacementSpaceFor` for SHOWING a space, never for deciding on one. Behind
 * `placement-space-read-cache`, only the public `placement.getSpace` route reaches it.
 *
 * The space is viewer-independent, so its two row reads — who owns the target and the space rows
 * at each level of the cascade — are cached per row and read from the replica on a miss. What the
 * comments above call "computed at read" stays live here exactly as on the primary path: the price
 * range (score, tier, config) and the reserved free-slot count. The client re-reads this route with
 * `staleTime: 0` after a refused free claim to explain the refusal, and that re-read still sees a
 * live count.
 *
 * Why a replica and a cache are allowed here and nowhere else: nothing this returns is acted on.
 * Every path that allows, refuses or charges a placement calls `resolvePlacementSpaceFor`, which
 * reads both rows from the primary, uncached. A stale display is at worst an offer the mutation
 * then refuses, which is already true of any page left open.
 *
 * A storyline chapter (a `post` target) is not served from here: its target row carries the
 * storyline's status, takedown and removal, which have writers all over the storyline service.
 */
export function resolvePlacementSpaceForDisplay(
  input: SpaceTarget
): Promise<ResolvedPlacementSpace> {
  if (input.targetType === 'post') return resolvePlacementSpaceFor(input);
  return resolveSpaceWith(input, displayReads);
}

/**
 * The stalest a cached space row can be served. A write busts its own row (see
 * `bustPlacementSpaceRow`), so this bounds only a lost bust or a refill racing one.
 */
const SPACE_ROW_TTL = CacheTTL.sm;
/**
 * How long a bust keeps a cleared row uncached. Reads inside it go to the replica and are not
 * written back, so a replica still behind the delete cannot re-pin the old row. Well above normal
 * replica lag; a lag longer than this is bounded by `SPACE_ROW_TTL`.
 */
const SPACE_ROW_BUST_WINDOW = 10;
/**
 * The stalest a cached target can be served: an owner's renamed username, or an image deleted since.
 * No bust — both have writers far from this service — and both are display-only here: the name is
 * shown to the placer, and a deleted image's placement is refused by the primary read.
 */
const SPACE_TARGET_TTL = CacheTTL.md;

type CachedSpaceRow = SpaceRow & { entityId: number };
type CachedSpaceTarget = {
  targetId: number;
  userId: number;
  postId: number | null;
  type: ImageTargetRow['type'] | null;
  username: string | null;
};
type CachedTargetType = Exclude<PlacementTargetType, 'post'>;

function createSpaceRowCache(surface: PlacementSurface, entityType: string) {
  return createCachedObject<CachedSpaceRow>({
    key: `${REDIS_KEYS.CACHES.PLACEMENT_SPACE}:row:${surface}:${entityType}`,
    idKey: 'entityId',
    ttl: SPACE_ROW_TTL,
    debounceTime: SPACE_ROW_BUST_WINDOW,
    // Most levels have no row of their own; the "none" answer is the one worth holding.
    cacheNotFound: true,
    staleWhileRevalidate: false,
    // `fromWrite` is `refresh` after a write: that one must read the row just written.
    lookupFn: async (ids, fromWrite) => {
      const { kyselyRead, kyselyWrite } = await loadKyselyDb();
      const db = fromWrite ? kyselyWrite : kyselyRead;
      const found: Record<string, CachedSpaceRow> = {};
      await Promise.all(
        ids.map(async (entityId) => {
          const [row] = await listPlacementSpacesFor(db, {
            surface,
            levels: [{ entityType, entityId }],
          });
          if (row) found[entityId] = { ...row, entityId };
        })
      );
      return found;
    },
  });
}

function createSpaceTargetCache(targetType: CachedTargetType) {
  const read = async (db: KyselyClient, id: number) => {
    if (targetType === 'model') {
      const row = await getModelPlacementTarget(db, id);
      return row && { userId: row.userId, postId: null, type: null, username: row.username };
    }
    return getImagePlacementTarget(db, id);
  };
  return createCachedObject<CachedSpaceTarget>({
    key: `${REDIS_KEYS.CACHES.PLACEMENT_SPACE}:target:${targetType}`,
    idKey: 'targetId',
    ttl: SPACE_TARGET_TTL,
    // A missing target is not held: an image too new for the replica would otherwise be refused as
    // "no longer exists" for the whole TTL.
    cacheNotFound: false,
    staleWhileRevalidate: false,
    lookupFn: async (ids, fromWrite) => {
      const { kyselyRead, kyselyWrite } = await loadKyselyDb();
      const found: Record<string, CachedSpaceTarget> = {};
      await Promise.all(
        ids.map(async (targetId) => {
          // The primary only for what the replica does not have yet, so a just-uploaded image is
          // not refused here when the primary path would accept it.
          const row =
            (fromWrite ? undefined : await read(kyselyRead, targetId)) ??
            (await read(kyselyWrite, targetId));
          if (row)
            found[targetId] = {
              targetId,
              userId: row.userId,
              postId: row.postId ?? null,
              type: row.type ?? null,
              username: row.username ?? null,
            };
        })
      );
      return found;
    },
  });
}

type KyselyClient = Awaited<ReturnType<typeof loadKyselyDb>>['kyselyRead'];

// Created on first use, never at import (the repo's no-module-scope-cache rule).
const spaceRowCaches = new Map<string, ReturnType<typeof createSpaceRowCache>>();
function spaceRowCache(surface: PlacementSurface, entityType: string) {
  const name = `${surface}:${entityType}`;
  let cache = spaceRowCaches.get(name);
  if (!cache) spaceRowCaches.set(name, (cache = createSpaceRowCache(surface, entityType)));
  return cache;
}
const spaceTargetCaches: Partial<
  Record<CachedTargetType, ReturnType<typeof createSpaceTargetCache>>
> = {};
function spaceTargetCache(targetType: CachedTargetType) {
  return (spaceTargetCaches[targetType] ??= createSpaceTargetCache(targetType));
}

/** The same rows and the same target the primary reads return, through the caches above. */
const displayReads: SpaceReads = {
  target: async (targetType, targetId) => {
    if (targetType === 'post') return resolveTarget(targetType, targetId);
    const row = (await spaceTargetCache(targetType).fetch(targetId))[targetId];
    if (targetType === 'model') return modelTargetFrom(row);
    return imageTargetFrom(row && { ...row, type: row.type as ImageTargetRow['type'] });
  },
  rows: async (surface, levels) => {
    const rows = await Promise.all(
      levels.map(
        async ({ entityType, entityId }) =>
          (
            await spaceRowCache(surface, entityType).fetch(entityId)
          )[entityId]
      )
    );
    return rows.filter((row): row is CachedSpaceRow => row !== undefined);
  },
};

/**
 * Called after every write to a `PlacementSpace` row. Unconditional — not behind the flag — so a
 * flag turned off and on again cannot find a row written while it was off.
 *
 * An upsert writes the new row through from the primary, so the owner's next look at their own
 * image shows what they just set. A delete marks the row uncached for `SPACE_ROW_BUST_WINDOW`
 * instead: a plain delete would let the next miss re-read the old row from a replica still behind.
 *
 * Never throws. The write has already committed; a failed bust is bounded by `SPACE_ROW_TTL`.
 *
 * Every writer of the table, so a new one is added here: `setPlacementSpace` and
 * `clearPlacementSpace` below. The only other is the storyline delete's raw `DELETE` of a
 * `storyline`-level row, which no display read caches (storylines are not served from here).
 */
export async function bustPlacementSpaceRow(
  { surface, entityType, entityId }: { surface: PlacementSurface } & SpaceLevel,
  how: 'written' | 'deleted'
) {
  try {
    const cache = spaceRowCache(surface, entityType);
    if (how === 'written') await cache.refresh(entityId);
    else await cache.bust(entityId);
  } catch {
    // Bounded by the TTL; see above.
  }
}

// #endregion

/**
 * Ownership of the entity whose space is being configured, from the primary.
 *
 * A moderator is not given a bypass here. Space settings are the creator's
 * consent to being placed on, and there is no moderation case for granting that
 * on someone's behalf — the moderator powers are suspension and removal.
 */
async function assertOwnsSpaceEntity({
  entityType,
  entityId,
  userId,
}: {
  entityType: PlacementSpaceEntity;
  entityId: number;
  userId: number;
}) {
  if (entityType === 'user') {
    if (entityId !== userId) throw throwAuthorizationError('placement: that is not your account');
    return;
  }

  // Its own branch, never the post lookup below: a storyline id and a post id
  // are different tables, and the same number would name someone else's post.
  if (entityType === 'storyline') {
    const storyline = await dbWrite.storyline.findUnique({
      where: { id: entityId },
      select: { userId: true },
    });
    if (!storyline) throw throwBadRequestError('placement: that storyline no longer exists');
    if (storyline.userId !== userId)
      throw throwAuthorizationError('placement: that is not your storyline');
    return;
  }

  const owner =
    entityType === 'image'
      ? (await dbWrite.image.findUnique({ where: { id: entityId }, select: { userId: true } }))
          ?.userId
      : (await dbWrite.post.findUnique({ where: { id: entityId }, select: { userId: true } }))
          ?.userId;

  if (owner == null) throw throwBadRequestError('placement: that content no longer exists');
  if (owner !== userId) throw throwAuthorizationError('placement: that is not your content');
}

export async function setPlacementSpace({
  surface,
  entityType,
  entityId,
  mode,
  price,
  freeSlots,
  declineFeePercent,
  settings,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  mode: PlacementSpaceMode;
  price?: number | null;
  /**
   * What the host keeps on a decline, in whole percent, on a surface that lets
   * them choose. `undefined` keeps, `null` returns to the surface default.
   * Refused outright on a surface whose fee is fixed.
   */
  declineFeePercent?: number | null;
  /**
   * `undefined` leaves this level's count alone, `null` clears it so the level
   * inherits again, and a number sets it — the same three-way distinction
   * `price` carries, for the same reason: an unset count follows the surface
   * default when that moves, where a stored one freezes today's.
   *
   * Stored uncapped. The score/tier ceiling is applied at read, exactly like the
   * price cap, so a creator whose tier lapses and returns gets their number back
   * rather than having found it silently rewritten.
   */
  freeSlots?: number | null;
  settings?: PlacementSpaceSettings;
  userId: number;
}) {
  // A storyline is configured on the storyline or the creator's account, and a
  // storyline row means nothing on any other surface: refused both ways rather
  // than written somewhere no resolver reads it.
  if ((entityType === 'storyline') !== (surface === 'storyline') && entityType !== 'user')
    throw throwBadRequestError(
      `placement: ${placementSurfaceLabel(surface)} are not configured on a ${entityType}`
    );

  await assertOwnsSpaceEntity({ entityType, entityId, userId });

  if (declineFeePercent !== undefined) {
    const refusal = hostDeclineFeePercentRefusal(surface, declineFeePercent);
    if (refusal) throw throwBadRequestError(`placement: ${refusal}`);
  }

  // An open space with no price is representable in the schema and meaningless
  // in the product: the placement mutation cannot decide what to charge, so it
  // would refuse every attempt while the owner's UI showed the space as open.
  // Requiring the price here makes that state unreachable rather than a puzzle
  // the placer discovers.
  const [existing, inherited] = await Promise.all([
    dbWrite.placementSpace.findUnique({
      where: { surface_entityType_entityId: { surface, entityType, entityId } },
      select: { price: true, settings: true },
    }),
    inheritedPrice({ surface, entityType, entityId, userId }),
  ]);

  // `undefined` leaves this level's own price alone, so the guard has to read it
  // rather than treating it as unset — otherwise it refuses a configuration the
  // cascade resolves fine, which is the disagreement this guard exists to avoid.
  const ownPrice = price === undefined ? existing?.price ?? null : price;
  const resolvedPrice = ownPrice ?? inherited ?? PLACEMENT_SURFACES[surface].defaultPrice;

  // No guard against clearing a stored price, and that is deliberate rather than
  // an omission.
  //
  // It was guarded while the account price was a free-form number field, where
  // "cleared" and "mid-edit" look identical: a creator charging 500 who blanks
  // the box means "set my own price", not "take the platform default". Every
  // control is now a slider that cannot emit an empty value, so the only route
  // here is a labelled button that says what it does — and refusing a deliberate
  // action because an accidental one used to be possible is the wrong trade.
  if (mode !== 'off' && resolvedPrice == null)
    throw throwBadRequestError('placement: set a price before opening this space');

  // Nothing verifies that a remix-gallery submission is genuinely a remix, so
  // the price is the only spam gate the surface has and a creator who sets 1⚡
  // is the hole. The slider's floor is a courtesy; this is what makes it true.
  //
  // Compared against the stored price rather than applied outright, because the
  // settings page sends `price` on every save — a creator whose row predates the
  // floor would be unable to change their mode, or turn the surface off at all,
  // until they first raised a price they set legitimately. Refuses a move below
  // the floor; lets an existing one be carried.
  const floor = PLACEMENT_SURFACES[surface].serverMinPrice;
  if (price != null && price < floor && price !== existing?.price)
    throw throwBadRequestError(`placement: the lowest you can charge is ${floor} Buzz`);

  // The decline fee rides in `settings` but is not the settings caller's to
  // drop: a wholesale settings replace carries the stored value over unless this
  // call set it. A fixed surface never stores one, whatever the row says.
  const storedSettings = (existing?.settings ?? {}) as PlacementSpaceSettings;
  const nextSettings = (() => {
    if (settings === undefined && declineFeePercent === undefined) return undefined;
    const { [HOST_DECLINE_FEE_SETTING]: storedFee, ...base } = settings ?? storedSettings;
    if (!isDeclineFeeHostAdjustable(surface)) return base;
    const fee =
      declineFeePercent === undefined
        ? storedSettings[HOST_DECLINE_FEE_SETTING]
        : declineFeePercent;
    return fee == null ? base : { ...base, [HOST_DECLINE_FEE_SETTING]: fee };
  })();

  await dbWrite.placementSpace.upsert({
    where: { surface_entityType_entityId: { surface, entityType, entityId } },
    create: {
      surface,
      entityType,
      entityId,
      mode,
      price: price ?? null,
      freeSlots: freeSlots ?? null,
      settings: (nextSettings ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      mode,
      ...(price === undefined ? {} : { price }),
      ...(freeSlots === undefined ? {} : { freeSlots }),
      // Replaced wholesale, not merged: the caller sends the settings it owns,
      // and a merge here would make a removed key impossible to express.
      ...(nextSettings === undefined ? {} : { settings: nextSettings as Prisma.InputJsonValue }),
    },
  });
  await bustPlacementSpaceRow({ surface, entityType, entityId }, 'written');
}

/**
 * What this level would inherit if it set no price of its own.
 *
 * Checked so that turning a single image on does not demand a price the owner
 * already set on their account — the cascade resolves price independently of
 * mode, and this guard has to agree with it or it refuses valid configurations.
 */
async function inheritedPrice({
  surface,
  entityType,
  entityId,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  userId: number;
}) {
  if (entityType === 'user') return null;

  // A storyline inherits from its creator's account only. Read as a post here,
  // its id would pull some unrelated post's price into the guard.
  if (entityType === 'storyline') {
    const row = await dbWrite.placementSpace.findUnique({
      where: { surface_entityType_entityId: { surface, entityType: 'user', entityId: userId } },
      select: { price: true },
    });
    return row?.price ?? null;
  }

  const postId =
    entityType === 'image'
      ? (await dbWrite.image.findUnique({ where: { id: entityId }, select: { postId: true } }))
          ?.postId ?? null
      : entityId;

  const rows = await dbWrite.placementSpace.findMany({
    where: {
      surface,
      OR: [
        ...(entityType === 'image' && postId ? [{ entityType: 'post', entityId: postId }] : []),
        { entityType: 'user', entityId: userId },
      ],
    },
    select: { entityType: true, price: true },
  });

  return (
    rows.find((row) => row.entityType === 'post')?.price ??
    rows.find((row) => row.entityType === 'user')?.price ??
    null
  );
}

/** Every space row an owner has set, for the settings surfaces. */
export const getPlacementSpaces = ({
  surface,
  userId,
}: {
  surface: PlacementSurface;
  userId: number;
}) =>
  dbRead.placementSpace.findMany({
    where: { surface, entityType: 'user', entityId: userId },
    select: {
      entityType: true,
      entityId: true,
      mode: true,
      price: true,
      freeSlots: true,
      settings: true,
    },
  });

/**
 * One level's own row, for editing that level rather than the resolved cascade.
 *
 * The cascade answers "what governs this image"; this answers "what has this
 * post been set to", which is what a toggle has to show. Conflating them would
 * make an inherited account setting look like a post-level one, and turning it
 * off would appear to do nothing.
 */
export async function getPlacementSpaceRow({
  surface,
  entityType,
  entityId,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  userId: number;
}) {
  await assertOwnsSpaceEntity({ entityType, entityId, userId });

  return dbRead.placementSpace.findUnique({
    where: { surface_entityType_entityId: { surface, entityType, entityId } },
    select: { mode: true, price: true, freeSlots: true, settings: true },
  });
}

/**
 * Removes a level's own row so it inherits again.
 *
 * A delete, not `mode: 'off'`. Those are different statements — off is a
 * deliberate no at this level, inherit is deferring to the level above — and
 * writing one for the other means an owner who later changes their account
 * setting finds this post silently ignoring it.
 */
export async function clearPlacementSpace({
  surface,
  entityType,
  entityId,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  userId: number;
}) {
  await assertOwnsSpaceEntity({ entityType, entityId, userId });

  await dbWrite.placementSpace.deleteMany({ where: { surface, entityType, entityId } });
  await bustPlacementSpaceRow({ surface, entityType, entityId }, 'deleted');
}
