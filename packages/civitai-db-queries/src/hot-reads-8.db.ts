import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Kysely ports of high-volume Prisma reads, served behind the default-off server Flipt flag
// `kysely-hot-reads-8`; off, the Prisma reads run unchanged. The app-side wrappers
// (<civitai>/src/server/services/hot-reads-8.reads.ts) map these rows to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-8.kysely-parity.test.ts compares the two
// against a real database.
//
// Every statement reads base TABLES only, never a view: the parity suite fails if one of them names
// a relation declared `/// @view`. None of them is given an empty id list: the wrappers answer that
// case without a statement, as Prisma does.

// --- A page of posts' storyline chapters (`getStorylinesForPosts`, the storyline pill on cards) ---

/** The chapter of each of these posts that is one, unordered (`postId` is unique). */
export function listStorylineChaptersByPostIds(db: Kysely<DB>, postIds: number[]) {
  return db
    .selectFrom('StorylineChapter')
    .select([
      'StorylineChapter.id',
      'StorylineChapter.postId',
      'StorylineChapter.depth',
      'StorylineChapter.removedAt',
      'StorylineChapter.storylineId',
    ])
    .where('StorylineChapter.postId', 'in', postIds)
    .execute();
}

/** These storylines with their owner's ban and deletion, unordered. */
export function listStorylinesWithOwner(db: Kysely<DB>, storylineIds: number[]) {
  return db
    .selectFrom('Storyline')
    .innerJoin('User', 'User.id', 'Storyline.userId')
    .select([
      'Storyline.id',
      'Storyline.title',
      'Storyline.userId',
      'Storyline.maxNsfwLevel',
      'Storyline.minorByScan',
      'Storyline.tosViolation',
      'Storyline.nsfwLevel',
      'Storyline.moderatorNsfwLevel',
      'User.bannedAt as ownerBannedAt',
      'User.deletedAt as ownerDeletedAt',
    ])
    .where('Storyline.id', 'in', storylineIds)
    .execute();
}

/** The first chapter (depth 0, at most one each) of these storylines, unordered. */
export function listStorylineRootChapters(db: Kysely<DB>, storylineIds: number[]) {
  return db
    .selectFrom('StorylineChapter')
    .select([
      'StorylineChapter.id',
      'StorylineChapter.postId',
      'StorylineChapter.removedAt',
      'StorylineChapter.storylineId',
    ])
    .where('StorylineChapter.depth', '=', 0)
    .where('StorylineChapter.storylineId', 'in', storylineIds)
    .execute();
}

/** These posts with their author's ban and deletion, unordered. */
export function listStorylinePostsWithAuthor(db: Kysely<DB>, postIds: number[]) {
  return db
    .selectFrom('Post')
    .innerJoin('User', 'User.id', 'Post.userId')
    .select([
      'Post.id',
      'Post.nsfwLevel',
      'Post.userId',
      'Post.tosViolation',
      'Post.publishedAt',
      'User.bannedAt as authorBannedAt',
      'User.deletedAt as authorDeletedAt',
    ])
    .where('Post.id', 'in', postIds)
    .execute();
}

// --- A user's cosmetics (`getUserCosmetics`, user.getCosmetics) ---

/** The user's id when there is such a user (`undefined` otherwise). */
export function getUserIdIfExists(db: Kysely<DB>, userId: number) {
  return db.selectFrom('User').select('User.id').where('User.id', '=', userId).executeTakeFirst();
}

/**
 * A user's cosmetics, each with its cosmetic, optionally only the equipped ones, in primary-key
 * order (cosmetic id, then claim key).
 */
export function listUserCosmeticsWithCosmetic(
  db: Kysely<DB>,
  { userId, equipped }: { userId: number; equipped?: boolean }
) {
  let query = db
    .selectFrom('UserCosmetic')
    .innerJoin('Cosmetic', 'Cosmetic.id', 'UserCosmetic.cosmeticId')
    .select([
      'UserCosmetic.obtainedAt',
      'UserCosmetic.equippedAt',
      'UserCosmetic.equippedToId',
      'UserCosmetic.equippedToType',
      'UserCosmetic.forId',
      'UserCosmetic.forType',
      'UserCosmetic.claimKey',
      'UserCosmetic.data',
      'Cosmetic.id as cosmeticId',
      'Cosmetic.name as cosmeticName',
      'Cosmetic.description as cosmeticDescription',
      'Cosmetic.type as cosmeticType',
      'Cosmetic.source as cosmeticSource',
      'Cosmetic.data as cosmeticData',
      'Cosmetic.createdById as cosmeticCreatedById',
      'Cosmetic.flags as cosmeticFlags',
    ])
    .where('UserCosmetic.userId', '=', userId);
  if (equipped) query = query.where('UserCosmetic.equippedAt', 'is not', null);
  return query.orderBy('UserCosmetic.cosmeticId').orderBy('UserCosmetic.claimKey').execute();
}

// --- A model version and its model's owner (`modelVersionDonationGoal`, a signed-in viewer) ---

/** The version's id and model id with its model's owner, `undefined` when there is no such version. */
export function getModelVersionWithOwner(db: Kysely<DB>, versionId: number) {
  return db
    .selectFrom('ModelVersion')
    .innerJoin('Model', 'Model.id', 'ModelVersion.id') // MUTANT M3
    .select(['ModelVersion.id', 'ModelVersion.modelId', 'Model.userId'])
    .where('ModelVersion.id', '=', versionId)
    .executeTakeFirst();
}
