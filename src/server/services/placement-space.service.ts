import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getPlacementConfig, placementPriceRange } from '~/server/services/placement.service';
import { throwBadRequestError, throwAuthorizationError } from '~/server/utils/errorHandling';
import type {
  PlacementSpaceEntity,
  PlacementSpaceMode,
  PlacementSpaceSetting,
  PlacementSpaceSettings,
  PlacementSurface,
} from '~/shared/utils/placement';
import {
  effectiveFreeSlots,
  effectivePlacementPrice,
  FREE_SLOT_HOLDING_STATUSES,
  PLACEMENT_SURFACES,
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
  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    // The username rides along on the lookup that was already happening. It is
    // shown to the placer, so the alternative — a second query keyed on the id
    // this one just returned — would be a round trip for a string this row can
    // reach in the same hop.
    select: { id: true, userId: true, postId: true, user: { select: { username: true } } },
  });
  if (!image) throw throwBadRequestError('placement: that image no longer exists');

  return {
    ownerId: image.userId,
    postId: image.postId,
    ownerUsername: image.user?.username ?? null,
  };
}

export type ResolvedPlacementSpace = {
  ownerId: number;
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
 */
export const reservedFreeSlots = (
  /**
   * Narrowed to the one model it touches so a transaction client satisfies it.
   * The claim MUST pass its `tx` — counting on any other connection would read
   * outside the lock it just took, and the count would be a listing again.
   */
  client: Pick<typeof dbWrite, 'placement'>,
  {
    surface,
    targetType,
    targetId,
  }: { surface: PlacementSurface; targetType: PlacementSpaceEntity; targetId: number }
) =>
  client.placement.count({
    where: {
      surface,
      targetType,
      targetId,
      free: true,
      status: { in: [...FREE_SLOT_HOLDING_STATUSES] },
    },
  });

/**
 * The space that governs one target, with the cascade already applied.
 *
 * The effective price is computed at read on purpose: a membership lapse or a
 * score change must move the cap immediately, and a stored effective price goes
 * stale with nothing failing to say so.
 */
export async function resolvePlacementSpaceFor({
  surface,
  targetType,
  targetId,
}: {
  surface: PlacementSurface;
  targetType: PlacementSpaceEntity;
  targetId: number;
}): Promise<ResolvedPlacementSpace> {
  if (!surfaceAcceptsTarget(surface, targetType))
    throw throwBadRequestError(`placement: ${surface} cannot be placed on a ${targetType}`);

  const { ownerId, postId, ownerUsername } = await resolveImageTarget(targetId);

  const rows = await dbWrite.placementSpace.findMany({
    where: {
      surface,
      OR: [
        { entityType: 'image', entityId: targetId },
        ...(postId ? [{ entityType: 'post', entityId: postId }] : []),
        { entityType: 'user', entityId: ownerId },
      ],
    },
    select: { entityType: true, mode: true, price: true, freeSlots: true, settings: true },
  });

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

  const resolved = resolvePlacementSpace(surface, {
    image: at('image'),
    post: at('post'),
    user: at('user'),
  });

  const { max: cap, freeSlotCap } = await placementPriceRange(ownerId, surface);
  const shares = (await getPlacementConfig()).approvalShares(surface);

  // `resolvePlacementSpace` is the one place the surface default is applied, so
  // this reads it rather than defaulting again — the same shape as `setPrice`
  // directly above.
  const setFreeSlots = resolved.freeSlots;
  const freeSlots = effectiveFreeSlots(setFreeSlots, freeSlotCap);
  // `dbRead`, unlike everything above it. The rest of this function decides
  // whether a mutation is allowed and what it charges, which a lagging replica
  // must not answer; `freeSlotsRemaining` is display-only by construction — the
  // claim re-counts under its own lock — and this read is on a public query
  // reached from every image detail view.
  //
  // Skipped when there is no capacity to reserve against. That is rarer than it
  // looks: the default and the bottom band are both 1, so it fires only for a
  // creator who has explicitly closed their slots.
  const reserved =
    freeSlots > 0 ? await reservedFreeSlots(dbRead, { surface, targetType, targetId }) : 0;

  return {
    ownerId,
    ownerUsername,
    mode: resolved.mode,
    setPrice: resolved.price,
    price: effectivePlacementPrice(resolved.price, cap),
    cap,
    ownerShare: 1 - shares.seller - shares.platform,
    setFreeSlots,
    freeSlots,
    freeSlotCap,
    freeSlotsRemaining: Math.max(freeSlots - reserved, 0),
    settings: resolved.settings ?? {},
  };
}

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
  settings,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  mode: PlacementSpaceMode;
  price?: number | null;
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
  await assertOwnsSpaceEntity({ entityType, entityId, userId });

  // An open space with no price is representable in the schema and meaningless
  // in the product: the placement mutation cannot decide what to charge, so it
  // would refuse every attempt while the owner's UI showed the space as open.
  // Requiring the price here makes that state unreachable rather than a puzzle
  // the placer discovers.
  const [existing, inherited] = await Promise.all([
    dbWrite.placementSpace.findUnique({
      where: { surface_entityType_entityId: { surface, entityType, entityId } },
      select: { price: true },
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

  await dbWrite.placementSpace.upsert({
    where: { surface_entityType_entityId: { surface, entityType, entityId } },
    create: {
      surface,
      entityType,
      entityId,
      mode,
      price: price ?? null,
      freeSlots: freeSlots ?? null,
      settings: (settings ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      mode,
      ...(price === undefined ? {} : { price }),
      ...(freeSlots === undefined ? {} : { freeSlots }),
      // Replaced wholesale, not merged: the caller sends the settings it owns,
      // and a merge here would make a removed key impossible to express.
      ...(settings === undefined ? {} : { settings: settings as Prisma.InputJsonValue }),
    },
  });
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
}
