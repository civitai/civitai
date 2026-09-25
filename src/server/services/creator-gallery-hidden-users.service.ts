import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

const BUST_CHUNK_SIZE = 500;
// A rebuild that read the list before a write can land its SET after that write's delete, and the
// entry lives a week, so the delete runs once more after the rebuild window has passed.
const REBUST_DELAY_MS = 5_000;
// Classed two-argument key, so it cannot collide with the other advisory locks' key spaces.
const HIDDEN_USERS_LOCK_CLASS = 0x47480001;

// The table has no FK, so rows for deleted accounts stay; the join is what drops them.
// `fresh` reads the primary: a caller caching the result for a week must not cache a replica that
// has not yet seen the write whose bust triggered the rebuild.
export async function getCreatorGalleryHiddenUserIds(
  creatorId: number,
  { fresh = false }: { fresh?: boolean } = {}
) {
  const db = fresh ? dbWrite : dbRead;
  const rows = await db.$queryRaw<{ userId: number }[]>`
    SELECT h."userId"
    FROM "CreatorGalleryHiddenUser" h
    JOIN "User" u ON u.id = h."userId" AND u."deletedAt" IS NULL
    WHERE h."creatorId" = ${creatorId}
  `;
  return rows.map((row) => row.userId);
}

export async function getCreatorGalleryHiddenUsers(creatorId: number) {
  return dbRead.$queryRaw<
    { id: number; username: string | null; note: string | null; createdAt: Date }[]
  >`
    SELECT u.id, u.username, h.note, h."createdAt"
    FROM "CreatorGalleryHiddenUser" h
    JOIN "User" u ON u.id = h."userId" AND u."deletedAt" IS NULL
    WHERE h."creatorId" = ${creatorId}
    ORDER BY h."createdAt" DESC
  `;
}

export async function addCreatorGalleryHiddenUser({
  creatorId,
  userId,
  note,
}: {
  creatorId: number;
  userId: number;
  note?: string | null;
}) {
  if (creatorId === userId) throw throwBadRequestError('You cannot hide yourself');

  const target = await dbRead.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  });
  if (!target) throw throwBadRequestError('User not found');

  // The lock serialises one creator's adds, so parallel requests cannot all pass the cap check.
  await dbWrite.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HIDDEN_USERS_LOCK_CLASS}::int, ${creatorId}::int)`;
    const [count, existing] = await Promise.all([
      tx.creatorGalleryHiddenUser.count({ where: { creatorId } }),
      tx.creatorGalleryHiddenUser.findUnique({
        where: { creatorId_userId: { creatorId, userId } },
        select: { userId: true },
      }),
    ]);
    if (!existing && count >= constants.modelGallery.maxCreatorHiddenUsers)
      throw throwBadRequestError(
        `You can hide at most ${constants.modelGallery.maxCreatorHiddenUsers} users across your galleries`
      );

    await tx.creatorGalleryHiddenUser.upsert({
      where: { creatorId_userId: { creatorId, userId } },
      create: { creatorId, userId, note: note || null },
      update: { note: note || null },
    });
  });
  await bustCreatorGallerySettings(creatorId);
}

// The note is not part of any cached gallery payload, so editing it busts nothing.
export async function updateCreatorGalleryHiddenUserNote({
  creatorId,
  userId,
  note,
}: {
  creatorId: number;
  userId: number;
  note?: string | null;
}) {
  const { count } = await dbWrite.creatorGalleryHiddenUser.updateMany({
    where: { creatorId, userId },
    data: { note: note || null },
  });
  if (!count) throw throwNotFoundError('That user is not on your hidden list');
}

export async function removeCreatorGalleryHiddenUser({
  creatorId,
  userId,
}: {
  creatorId: number;
  userId: number;
}) {
  await dbWrite.creatorGalleryHiddenUser.deleteMany({ where: { creatorId, userId } });
  await bustCreatorGallerySettings(creatorId);
}

export async function bustCreatorGallerySettings(creatorId: number) {
  const models = await dbWrite.model.findMany({
    where: { userId: creatorId },
    select: { id: true },
  });
  await bustModelGallerySettings(models.map((m) => m.id));
}

export async function bustModelGallerySettings(modelIds: number[]) {
  await deleteModelGallerySettingsKeys(modelIds);
  setTimeout(
    () => deleteModelGallerySettingsKeys(modelIds).catch(() => null),
    REBUST_DELAY_MS
  ).unref?.();
}

async function deleteModelGallerySettingsKeys(modelIds: number[]) {
  for (let i = 0; i < modelIds.length; i += BUST_CHUNK_SIZE) {
    const keys = modelIds
      .slice(i, i + BUST_CHUNK_SIZE)
      .map((id) => `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}` as const);
    await redis.del(keys);
  }
}
