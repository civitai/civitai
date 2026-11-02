import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countHeldItemsByDefinitionId,
  hasStorylineChapterForPosts,
  listModelSfwNames,
  listPostModelVersionIds,
} from '@civitai/db-queries/hot-reads-7';
import { countHeldItemsByDefinition, USER_HOLDER } from '~/server/services/item.service';

/**
 * The reads behind `kysely-hot-reads-7`, each as a Prisma reader and its Kysely twin taking the
 * client, so the parity suite (__tests__/hot-reads-7.kysely-parity.test.ts) runs the very code the
 * services run. The Prisma readers are the original reads, moved here verbatim (the storyline
 * chapter read stays in its service, which shares its filter from here); each twin returns the value
 * its Prisma reader returns. An empty id list answers without a statement, as Prisma does.
 */

// The storyline chapters of a page of posts (`getStorylinesForPosts`, storyline.service.ts).

/** The chapters' filter, shared by the service's Prisma read and the probe's parity check. */
export function storylineChaptersForPostsWhere(postIds: number[]) {
  return { postId: { in: postIds } } satisfies Prisma.StorylineChapterWhereInput;
}

/**
 * Whether the service's chapter read can return any row. Most pages hold no chapter, so ON this
 * one-row probe answers them and the nested Prisma read runs only for a page that has one.
 */
export async function readHasStorylineChapterViaKysely(db: Kysely<DB>, postIds: number[]) {
  if (!postIds.length) return false;
  return hasStorylineChapterForPosts(db, postIds);
}

// The .com titles of a set of models (`getSfwModelNames`, model-sfw-face.service.ts).

export async function readSfwModelNamesViaPrisma(db: PrismaClient, ids: number[]) {
  const models = await db.model.findMany({
    where: { id: { in: ids }, sfwName: { not: null } },
    select: { id: true, sfwName: true },
  });
  return new Map(models.map((model) => [model.id, model.sfwName as string]));
}

export async function readSfwModelNamesViaKysely(db: Kysely<DB>, ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const models = await listModelSfwNames(db, ids);
  return new Map(models.map((model) => [model.id, model.sfwName as string]));
}

// A set of posts' model versions (the post-version cache's lookup, model.service.ts).

export function readPostModelVersionIdsViaPrisma(db: PrismaClient, ids: number[]) {
  return db.post.findMany({
    where: { id: { in: ids } },
    select: { id: true, modelVersionId: true },
  });
}

export async function readPostModelVersionIdsViaKysely(
  db: Kysely<DB>,
  ids: number[]
): Promise<Awaited<ReturnType<typeof readPostModelVersionIdsViaPrisma>>> {
  if (!ids.length) return [];
  return listPostModelVersionIds(db, ids);
}

// A user's held items of one definition type and set of statuses, counted by definition
// (`readVisibleHeldKinds`, mystery-box-inventory.service.ts).

export type HeldItemCountsInput = { userId: number; type: string; statuses: string[] };

/** The Prisma read the service ran: `countHeldItemsByDefinition` with that definition filter. */
export function readHeldItemCountsViaPrisma(
  db: PrismaClient,
  { userId, type, statuses }: HeldItemCountsInput
) {
  return countHeldItemsByDefinition(db, { userId, definition: { type, status: { in: statuses } } });
}

export async function readHeldItemCountsViaKysely(
  db: Kysely<DB>,
  { userId, type, statuses }: HeldItemCountsInput
): Promise<Map<number, number>> {
  if (!statuses.length) return new Map();
  const rows = await countHeldItemsByDefinitionId(db, {
    holderType: USER_HOLDER,
    holderId: userId,
    type,
    statuses,
  });
  return new Map(rows.map((row) => [row.itemDefinitionId, row.count]));
}
