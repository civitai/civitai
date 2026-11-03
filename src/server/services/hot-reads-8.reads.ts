import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getModelVersionWithOwner,
  getUserIdIfExists,
  listStorylineChaptersByPostIds,
  listStorylinePostsWithAuthor,
  listStorylineRootChapters,
  listStorylinesWithOwner,
  listUserCosmeticsWithCosmetic,
} from '@civitai/db-queries/hot-reads-8';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import {
  storylineRootChapterSelect,
  storylineTitleLevelSelect,
} from '~/server/selectors/storyline.selector';

/**
 * The reads behind `kysely-hot-reads-8`, each as a Prisma reader and its Kysely twin taking the
 * client, so the parity suite (__tests__/hot-reads-8.kysely-parity.test.ts) runs the very code the
 * services run. The Prisma readers are the original reads, moved here verbatim; each twin returns
 * the value its Prisma reader returns. An empty id list answers without a statement, as Prisma does.
 */

const uniq = <T>(values: T[]) => [...new Set(values)];
const isDefined = <T>(value: T | null | undefined): value is T => value != null;

// A page of posts' storyline chapters (`getStorylinesForPosts`, storyline.service.ts).

export function readStorylineChaptersForPostsViaPrisma(db: PrismaClient, postIds: number[]) {
  return db.storylineChapter.findMany({
    where: { postId: { in: postIds } },
    select: {
      id: true,
      postId: true,
      depth: true,
      removedAt: true,
      post: {
        select: {
          nsfwLevel: true,
          userId: true,
          tosViolation: true,
          user: { select: { bannedAt: true, deletedAt: true } },
        },
      },
      storyline: {
        select: {
          id: true,
          title: true,
          userId: true,
          maxNsfwLevel: true,
          minorByScan: true,
          tosViolation: true,
          ...storylineTitleLevelSelect,
          user: { select: { bannedAt: true, deletedAt: true } },
          chapters: storylineRootChapterSelect,
        },
      },
    },
  });
}

type StorylineChaptersForPosts = Awaited<ReturnType<typeof readStorylineChaptersForPostsViaPrisma>>;

/**
 * The same chapters, with each to-one relation Prisma reads in a query of its own joined instead:
 * one statement when no post is a chapter (the common case, and Prisma's first statement too), and
 * otherwise three more in two round trips (the storylines with their owners alongside their first
 * chapters, then every post those chapters name with its author). Each chapter gets its own
 * objects, as Prisma's.
 */
export async function readStorylineChaptersForPostsViaKysely(
  db: Kysely<DB>,
  postIds: number[]
): Promise<StorylineChaptersForPosts> {
  if (!postIds.length) return [];
  const chapters = await listStorylineChaptersByPostIds(db, postIds);
  if (!chapters.length) return [];

  const storylineIds = uniq(chapters.map((chapter) => chapter.storylineId));
  const [storylines, roots] = await Promise.all([
    listStorylinesWithOwner(db, storylineIds),
    listStorylineRootChapters(db, storylineIds),
  ]);
  const readPostIds = uniq(
    [...chapters.map((chapter) => chapter.postId), ...roots.map((root) => root.postId)].filter(
      isDefined
    )
  );
  const posts = readPostIds.length ? await listStorylinePostsWithAuthor(db, readPostIds) : [];

  const postById = new Map(posts.map((post) => [post.id, post]));
  const storylineById = new Map(storylines.map((storyline) => [storyline.id, storyline]));
  const rootByStoryline = new Map(roots.map((root) => [root.storylineId, root]));
  const authorOf = (post: (typeof posts)[number]) => ({
    bannedAt: post.authorBannedAt,
    deletedAt: post.authorDeletedAt,
  });

  return chapters.flatMap((chapter) => {
    // The storyline is a required relation, so a chapter always has one; a row that vanished
    // between statements is left out rather than served without it.
    const storyline = storylineById.get(chapter.storylineId);
    if (!storyline) return [];
    const post = chapter.postId != null ? postById.get(chapter.postId) : undefined;
    const root = rootByStoryline.get(chapter.storylineId);
    const rootPost = root?.postId != null ? postById.get(root.postId) : undefined;
    return [
      {
        id: chapter.id,
        postId: chapter.postId,
        depth: chapter.depth,
        removedAt: chapter.removedAt,
        post: post
          ? {
              nsfwLevel: post.nsfwLevel,
              userId: post.userId,
              tosViolation: post.tosViolation,
              user: authorOf(post),
            }
          : null,
        storyline: {
          id: storyline.id,
          title: storyline.title,
          userId: storyline.userId,
          maxNsfwLevel: storyline.maxNsfwLevel,
          minorByScan: storyline.minorByScan,
          tosViolation: storyline.tosViolation,
          nsfwLevel: storyline.nsfwLevel,
          moderatorNsfwLevel: storyline.moderatorNsfwLevel,
          user: { bannedAt: storyline.ownerBannedAt, deletedAt: storyline.ownerDeletedAt },
          chapters: root
            ? [
                {
                  id: root.id,
                  postId: root.postId,
                  removedAt: root.removedAt,
                  post: rootPost
                    ? {
                        nsfwLevel: rootPost.nsfwLevel,
                        publishedAt: rootPost.publishedAt,
                        tosViolation: rootPost.tosViolation,
                        user: authorOf(rootPost),
                      }
                    : null,
                },
              ]
            : [],
        },
      },
    ];
  });
}

// A user's cosmetics (`getUserCosmetics`, user.service.ts).

export type UserCosmeticsInput = { userId: number; equipped?: boolean };

/**
 * The cosmetic fields the read selects, in select order: `simpleCosmeticSelect` plus `createdById`
 * and `flags`. The Kysely twin lists the same columns by hand, and the parity suite fails if this
 * list and the shared selector drift apart.
 */
export const USER_COSMETIC_COSMETIC_FIELDS = [
  'id',
  'name',
  'description',
  'type',
  'source',
  'data',
  'createdById',
  'flags',
] as const;

export function readUserCosmeticsViaPrisma(
  db: PrismaClient,
  { userId, equipped }: UserCosmeticsInput
) {
  return db.user.findUnique({
    where: { id: userId },
    select: {
      cosmetics: {
        where: equipped ? { equippedAt: { not: null } } : undefined,
        select: {
          obtainedAt: true,
          equippedAt: true,
          equippedToId: true,
          equippedToType: true,
          forId: true,
          forType: true,
          claimKey: true,
          data: true,
          cosmetic: {
            // Spread rather than hand-listed, so a field added to the shared
            // selector reaches this read too — it is the one the whole cosmetics
            // UI runs on, and a divergence here surfaces as one surface missing a
            // field nobody thinks to check. (The Kysely twin below lists them by hand;
            // USER_COSMETIC_COSMETIC_FIELDS is pinned against this select by the parity suite.)
            //
            // `createdById` is extra: a scalar on the row already being selected,
            // so no join and no extra round trip, and it is what lets the sticker
            // tray filter to your own without asking a second procedure.
            select: { ...simpleCosmeticSelect, createdById: true, flags: true },
          },
        },
      },
    },
  });
}

type UserCosmetics = Awaited<ReturnType<typeof readUserCosmeticsViaPrisma>>;

/**
 * `null` when there is no such user, else the user's cosmetics in primary-key order (cosmetic id,
 * then claim key). The Prisma read has no `orderBy`, so its order is whatever Postgres returns,
 * which for this primary-key lookup is normally the same order.
 */
export async function readUserCosmeticsViaKysely(
  db: Kysely<DB>,
  input: UserCosmeticsInput
): Promise<UserCosmetics> {
  const [user, rows] = await Promise.all([
    getUserIdIfExists(db, input.userId),
    listUserCosmeticsWithCosmetic(db, input),
  ]);
  if (!user) return null;
  return {
    cosmetics: rows.map((row) => ({
      obtainedAt: row.obtainedAt,
      equippedAt: row.equippedAt,
      equippedToId: row.equippedToId,
      equippedToType: row.equippedToType,
      forId: row.forId,
      forType: row.forType,
      claimKey: row.claimKey,
      data: row.data as Prisma.JsonValue,
      cosmetic: {
        id: row.cosmeticId,
        name: row.cosmeticName,
        description: row.cosmeticDescription,
        type: row.cosmeticType,
        source: row.cosmeticSource,
        data: row.cosmeticData as Prisma.JsonValue,
        createdById: row.cosmeticCreatedById,
        flags: row.cosmeticFlags,
      },
    })),
  } as UserCosmetics;
}

// A model version and its model's owner (`modelVersionDonationGoal`, model-version.service.ts).

/** The Prisma read's arguments, shared with the service's primary retry. */
export const donationGoalVersionFindArgs = (id: number) =>
  ({
    where: { id },
    select: {
      id: true,
      modelId: true,
      model: {
        select: {
          userId: true,
        },
      },
    },
  } as const);

/** Rejects when there is no such version (`findFirstOrThrow`). */
export function readDonationGoalVersionViaPrisma(db: PrismaClient, id: number) {
  return db.modelVersion.findFirstOrThrow(donationGoalVersionFindArgs(id));
}

type DonationGoalVersion = Awaited<ReturnType<typeof readDonationGoalVersionViaPrisma>>;

/** Rejects when there is no such version, as the Prisma read does. */
export async function readDonationGoalVersionViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<DonationGoalVersion> {
  const row = await getModelVersionWithOwner(db, id);
  if (!row) throw new Error(`No ModelVersion found (id ${id})`);
  return { id: row.id, modelId: row.modelId, model: { userId: row.userId } };
}
