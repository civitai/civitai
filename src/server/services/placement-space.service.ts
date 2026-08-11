import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { placementPriceRange } from '~/server/services/placement.service';
import { throwBadRequestError, throwAuthorizationError } from '~/server/utils/errorHandling';
import type {
  PlacementSpaceEntity,
  PlacementSpaceMode,
  PlacementSpaceSetting,
  PlacementSpaceSettings,
  PlacementSurface,
} from '~/shared/utils/placement';
import {
  effectivePlacementPrice,
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
    select: { id: true, userId: true, postId: true },
  });
  if (!image) throw throwBadRequestError('placement: that image no longer exists');

  return { ownerId: image.userId, postId: image.postId };
}

export type ResolvedPlacementSpace = {
  ownerId: number;
  mode: PlacementSpaceMode;
  /** What the owner asks. `null` when they have never set one. */
  setPrice: number | null;
  /** `min(setPrice, cap)`, computed here and never stored. `null` when unpriced. */
  price: number | null;
  cap: number;
  /** Surface-owned; this layer carries it without reading inside it. */
  settings: PlacementSpaceSettings;
};

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

  const { ownerId, postId } = await resolveImageTarget(targetId);

  const rows = await dbWrite.placementSpace.findMany({
    where: {
      surface,
      OR: [
        { entityType: 'image', entityId: targetId },
        ...(postId ? [{ entityType: 'post', entityId: postId }] : []),
        { entityType: 'user', entityId: ownerId },
      ],
    },
    select: { entityType: true, mode: true, price: true, settings: true },
  });

  const at = (entityType: PlacementSpaceEntity): PlacementSpaceSetting | undefined => {
    const row = rows.find((candidate) => candidate.entityType === entityType);
    return row
      ? {
          mode: row.mode as PlacementSpaceMode,
          price: row.price,
          settings: (row.settings ?? {}) as PlacementSpaceSettings,
        }
      : undefined;
  };

  const resolved = resolvePlacementSpace(surface, {
    image: at('image'),
    post: at('post'),
    user: at('user'),
  });

  const { max: cap } = await placementPriceRange(ownerId, surface);

  return {
    ownerId,
    mode: resolved.mode,
    setPrice: resolved.price,
    price: effectivePlacementPrice(resolved.price, cap),
    cap,
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
  settings,
  userId,
}: {
  surface: PlacementSurface;
  entityType: PlacementSpaceEntity;
  entityId: number;
  mode: PlacementSpaceMode;
  price?: number | null;
  settings?: PlacementSpaceSettings;
  userId: number;
}) {
  await assertOwnsSpaceEntity({ entityType, entityId, userId });

  // An open space with no price is representable in the schema and meaningless
  // in the product: the placement mutation cannot decide what to charge, so it
  // would refuse every attempt while the owner's UI showed the space as open.
  // Requiring the price here makes that state unreachable rather than a puzzle
  // the placer discovers.
  const resolvedPrice = price ?? (await inheritedPrice({ surface, entityType, entityId, userId }));
  if (mode !== 'off' && resolvedPrice == null)
    throw throwBadRequestError('placement: set a price before opening this space');

  await dbWrite.placementSpace.upsert({
    where: { surface_entityType_entityId: { surface, entityType, entityId } },
    create: {
      surface,
      entityType,
      entityId,
      mode,
      price: price ?? null,
      settings: (settings ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      mode,
      ...(price === undefined ? {} : { price }),
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
    select: { entityType: true, entityId: true, mode: true, price: true, settings: true },
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
    select: { mode: true, price: true, settings: true },
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
