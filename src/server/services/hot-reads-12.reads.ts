import type { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getSimpleModelWithOwnerRow,
  listUsersWithCosmeticsRows,
  type UserWithCosmeticsRow,
} from '@civitai/db-queries/hot-reads-12';
import { dbRead } from '~/server/db/client';
import { getDbWithoutLag, kyselyMatching } from '~/server/db/db-lag-helpers';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { servableProfilePicture } from '~/server/services/profile-picture.servable';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * The reads behind `kysely-hot-reads-12`: two hot reads that nest `userWithCosmeticsSelect`, which
 * Prisma fans out into one statement per relation (the user, its profile picture, its equipped
 * cosmetics, and their cosmetic rows). Each has its Prisma reader, moved here verbatim, and a
 * Kysely twin taking the client, so the parity suite (__tests__/hot-reads-12.kysely-parity.test.ts)
 * runs the code the services run:
 *   - `model.getSimple` (`getSimpleModelWithVersions`): the model and its owner, ONE statement
 *     where Prisma issues one for the model plus one per user relation.
 *   - `resourceReview.getInfinite` (`getResourceReviewsInfinite`): the page of reviews still reads
 *     through Prisma (its filters and cursor are Prisma's), selecting `userId` instead of the
 *     nested user; the page's users are then ONE Kysely statement.
 */

type UserWithCosmetics = Prisma.UserGetPayload<{ select: typeof userWithCosmeticsSelect }>;
type ProfilePicture = NonNullable<UserWithCosmetics['profilePicture']>;
type Cosmetic = UserWithCosmetics['cosmetics'][number]['cosmetic'];

/** A `userWithCosmeticsSelect` payload from its Kysely row, keys in the select's order. */
function toUserWithCosmetics(row: UserWithCosmeticsRow): UserWithCosmetics {
  return {
    id: row.id,
    username: row.username,
    deletedAt: row.deletedAt,
    image: row.image,
    // One payload for every viewer, as Prisma's servable-profile-picture extension gives.
    profilePicture: servableProfilePicture(
      row.profilePictureId !== null
        ? {
            id: row.profilePictureId,
            name: row.profilePictureName,
            url: row.profilePictureUrl as string,
            nsfwLevel: row.profilePictureNsfwLevel as number,
            hash: row.profilePictureHash,
            userId: row.profilePictureUserId as number,
            ingestion: row.profilePictureIngestion as ProfilePicture['ingestion'],
            type: row.profilePictureType as ProfilePicture['type'],
            width: row.profilePictureWidth,
            height: row.profilePictureHeight,
            metadata: row.profilePictureMetadata as Prisma.JsonValue,
          }
        : null,
      row.profilePictureNeedsReview
    ),
    cosmetics: row.cosmetics.map((cosmetic) => ({
      data: cosmetic.data as Prisma.JsonValue,
      cosmetic: {
        id: cosmetic.cosmetic.id,
        data: cosmetic.cosmetic.data as Prisma.JsonValue,
        type: cosmetic.cosmetic.type as Cosmetic['type'],
        source: cosmetic.cosmetic.source as Cosmetic['source'],
        name: cosmetic.cosmetic.name,
      },
    })),
  };
}

/** `userIds`' `userWithCosmeticsSelect` payloads by id, from ONE statement (none for no ids). */
export async function readUsersWithCosmeticsViaKysely(
  db: Kysely<DB>,
  userIds: number[]
): Promise<Map<number, UserWithCosmetics>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const rows = await listUsersWithCosmeticsRows(db, ids);
  return new Map(rows.map((row) => [row.id, toUserWithCosmetics(row)]));
}

// --- model.getSimple ----------------------------------------------------------------------------

/** `null` when there is no such model (`findFirst`). The original read, verbatim. */
export function readSimpleModelWithOwnerViaPrisma(db: Prisma.TransactionClient, id: number) {
  return db.model.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      locked: true,
      status: true,
      user: { select: userWithCosmeticsSelect },
    },
  });
}

export type SimpleModelWithOwner = NonNullable<
  Awaited<ReturnType<typeof readSimpleModelWithOwnerViaPrisma>>
>;

/** The same model from ONE statement (`getSimpleModelWithOwnerRow`), `null` when there is none. */
export async function readSimpleModelWithOwnerViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<SimpleModelWithOwner | null> {
  const row = await getSimpleModelWithOwnerRow(db, id);
  if (!row) return null;
  return {
    id: row.modelId,
    name: row.modelName,
    createdAt: row.modelCreatedAt,
    locked: row.modelLocked,
    status: row.modelStatus as SimpleModelWithOwner['status'],
    user: toUserWithCosmetics(row),
  };
}

// --- resourceReview.getInfinite -----------------------------------------------------------------

/** The page's Prisma arguments, built by `getResourceReviewsInfinite`. */
export type ResourceReviewsPageArgs = {
  take: number;
  cursor: Prisma.ResourceReviewWhereUniqueInput | undefined;
  where: Prisma.ResourceReviewWhereInput;
  orderBy: Prisma.Enumerable<Prisma.ResourceReviewOrderByWithRelationInput>;
  /** `include` names `model`: each review also carries its model's and version's id and name. */
  includeModel: boolean;
};

/** The original page read, verbatim: the reviews with their user nested. */
export function readResourceReviewsPageViaPrisma(
  db: Prisma.TransactionClient,
  { includeModel, ...args }: ResourceReviewsPageArgs
) {
  return db.resourceReview.findMany({
    ...args,
    select: {
      id: true,
      modelId: true,
      modelVersionId: true,
      details: true,
      createdAt: true,
      rating: true,
      recommended: true,
      user: { select: userWithCosmeticsSelect },
      // helper: { select: { imageCount: true } },
      model: includeModel ? { select: { id: true, name: true } } : undefined,
      modelVersion: includeModel ? { select: { id: true, name: true } } : undefined,
    },
  });
}

export type ResourceReviewsPage = Awaited<ReturnType<typeof readResourceReviewsPageViaPrisma>>;

/**
 * The same page: the reviews through Prisma with `userId` in place of the nested user (the same
 * filters, cursor and order, so the same rows in the same order), then their users from ONE Kysely
 * statement. Keys are built in the order the Prisma select lists them. A review whose user is gone
 * throws, as Prisma's required relation does.
 */
export async function readResourceReviewsPageViaKysely(
  db: Prisma.TransactionClient,
  kysely: Kysely<DB>,
  { includeModel, ...args }: ResourceReviewsPageArgs
): Promise<ResourceReviewsPage> {
  const rows = await db.resourceReview.findMany({
    ...args,
    select: {
      id: true,
      modelId: true,
      modelVersionId: true,
      details: true,
      createdAt: true,
      rating: true,
      recommended: true,
      userId: true,
      model: includeModel ? { select: { id: true, name: true } } : undefined,
      modelVersion: includeModel ? { select: { id: true, name: true } } : undefined,
    },
  });
  const users = await readUsersWithCosmeticsViaKysely(
    kysely,
    rows.map((row) => row.userId)
  );
  const page = rows.map((row) => {
    const user = users.get(row.userId);
    if (!user)
      throw new Error(
        `Inconsistent query result: resource review ${row.id} has no user ${row.userId}`
      );
    return {
      id: row.id,
      modelId: row.modelId,
      modelVersionId: row.modelVersionId,
      details: row.details,
      createdAt: row.createdAt,
      rating: row.rating,
      recommended: row.recommended,
      user,
      // Absent, not `undefined`, when not selected: as Prisma leaves them out.
      ...('model' in row && { model: row.model }),
      ...('modelVersion' in row && { modelVersion: row.modelVersion }),
    };
  });
  return page as unknown as ResourceReviewsPage;
}

// --- the switch ---------------------------------------------------------------------------------

const readFlag = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_12);
let kyselyHotReads12 = createCachedFlagGate(readFlag);

/** Tests only: forget the cached flag read. */
export function resetHotReads12GateForTests() {
  kyselyHotReads12 = createCachedFlagGate(readFlag);
}

/**
 * `model.getSimple`'s read on the client the replication-lag check picks (the primary for a model
 * just written, else the replica): Prisma while `kysely-hot-reads-12` is off, one Kysely statement
 * on the matching pool while on. No Kysely row (a missing model, or one whose owner is gone) runs
 * the Prisma read, so a missing model is still `null` and an orphan still throws as Prisma throws.
 */
export async function readSimpleModelWithOwner(id: number): Promise<SimpleModelWithOwner | null> {
  const db = await getDbWithoutLag('model', id);
  if (kyselyHotReads12())
    return (
      (await readSimpleModelWithOwnerViaKysely(kyselyMatching(db), id)) ??
      readSimpleModelWithOwnerViaPrisma(db, id)
    );
  return readSimpleModelWithOwnerViaPrisma(db, id);
}

/**
 * `resourceReview.getInfinite`'s page on the replica: the nested Prisma read while
 * `kysely-hot-reads-12` is off; the reviews through Prisma and their users in one Kysely statement
 * (the replica too) while on.
 */
export async function readResourceReviewsPage(
  args: ResourceReviewsPageArgs
): Promise<ResourceReviewsPage> {
  if (kyselyHotReads12())
    return readResourceReviewsPageViaKysely(dbRead, kyselyMatching(dbRead), args);
  return readResourceReviewsPageViaPrisma(dbRead, args);
}
