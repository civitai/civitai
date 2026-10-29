import { sql, utc } from '@civitai/db/kysely';
import {
  REFERENCE_POOL,
  REFERENCE_SOURCE,
  REFERENCE_STATUS,
  servableImage,
} from '@civitai/db/knights';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { isRatingLevel } from '$lib/nsfw-levels';
import { dbWrite } from '../db';
import { CORESET, type CoreSetConfig } from './coreset.config';

export type CoreSetItem = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  source: string;
  status: string;
  answer: string;
  explanation: string | null;
  answers: number;
  failures: number;
  flagged: boolean;
  /** False when Acolytes would not be shown the image, for example after it was blocked. */
  servable: boolean;
  harvestedAt: Date;
};

/** Deliberately omits the stored rating so the re-rate stays blind. */
export type SpotCheckItem = { id: number; imageKey: string };

export type Outcome<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function references() {
  return dbWrite
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as ri', 'ri.id', 'r.imageId')
    .where('r.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION);
}

/** Players fail the item far more than expected, once enough have answered. Computed in SQL so it can order the list. */
const flaggedSql = (config: CoreSetConfig) =>
  sql<boolean>`("r"."answers" >= ${config.flagMinAnswers} AND "r"."answers" > 0 AND "r"."failures"::float8 >= ${config.flagFailureRate}::float8 * "r"."answers")`;

function listItems(config: CoreSetConfig) {
  return references().select((eb) => [
    'r.id',
    'r.imageId',
    'r.source',
    'r.status',
    'r.answer',
    'r.explanation',
    'r.answers',
    'r.failures',
    'r.harvestedAt',
    'ri.url as imageKey',
    'ri.name as imageName',
    flaggedSql(config).as('flagged'),
    sql<boolean>`${eb.exists(
      eb
        .selectFrom('Image as img')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select(sql<number>`1`.as('one'))
        .whereRef('img.id', '=', 'r.imageId')
        .where(servableImage)
    )}`.as('servable'),
  ]);
}

/** Retired items stay listed so they can be added back. */
export async function getCoreItems(config: CoreSetConfig = CORESET): Promise<CoreSetItem[]> {
  return listItems(config)
    .where('r.source', '=', REFERENCE_SOURCE.core)
    .orderBy(sql`("r"."status" = ${REFERENCE_STATUS.active})`, 'desc')
    .orderBy('r.id', 'asc')
    .limit(config.listLimit)
    .execute();
}

/** Fresh items in the Trials pool, flagged ones first so the limit never cuts them. */
export async function getFreshItems(config: CoreSetConfig = CORESET): Promise<CoreSetItem[]> {
  return listItems(config)
    .where('r.source', '!=', REFERENCE_SOURCE.core)
    .where('r.pool', '=', REFERENCE_POOL.trials)
    .where('r.status', '=', REFERENCE_STATUS.active)
    .orderBy(flaggedSql(config), 'desc')
    .orderBy('r.harvestedAt', 'desc')
    .orderBy('r.id', 'desc')
    .limit(config.listLimit)
    .execute();
}

export async function getSpotCheckItems(config: CoreSetConfig = CORESET): Promise<SpotCheckItem[]> {
  return references()
    .select(['r.id', 'ri.url as imageKey'])
    .where('r.pool', '=', REFERENCE_POOL.trials)
    .where('r.status', '=', REFERENCE_STATUS.pending)
    .orderBy('r.harvestedAt', 'asc')
    .orderBy('r.id', 'asc')
    .limit(config.listLimit)
    .execute();
}

export async function getCoreSetCounts() {
  const rows = await dbWrite
    .selectFrom('KnightsReferenceImage')
    .select(['source', 'pool', 'status', sql<string>`count(*)`.as('count')])
    .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .groupBy(['source', 'pool', 'status'])
    .execute();
  const sum = (match: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(match).reduce((total, r) => total + Number(r.count), 0);
  const active = (r: (typeof rows)[number]) => r.status === REFERENCE_STATUS.active;
  return {
    core: sum((r) => r.source === REFERENCE_SOURCE.core && active(r)),
    fresh: sum(
      (r) => r.source !== REFERENCE_SOURCE.core && r.pool === REFERENCE_POOL.trials && active(r)
    ),
    spotCheck: sum(
      (r) => r.pool === REFERENCE_POOL.trials && r.status === REFERENCE_STATUS.pending
    ),
  };
}

const BAD_LEVEL = 'Pick a rating level.';
const NEEDS_WHY = 'Explain why the image has this rating; Acolytes see it after they answer.';
const GONE = 'This item is no longer available. Reload the page.';

const validLevel = (level: number) => Number.isInteger(level) && isRatingLevel(level);

/** A new answer starts a new record: the old counts measured a different question. */
const keepCountsIf = (answer: string) =>
  ({
    answers: sql<number>`CASE WHEN "answer" = ${answer} THEN "answers" ELSE 0 END`,
    failures: sql<number>`CASE WHEN "answer" = ${answer} THEN "failures" ELSE 0 END`,
  } as const);

/** Returns an error message unless Acolytes would be shown the image. */
async function unservableReason(imageId: number): Promise<string | null> {
  const servable = await dbWrite
    .selectFrom('Image as img')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .select('img.id')
    .where('img.id', '=', imageId)
    .where(servableImage)
    .executeTakeFirst();
  if (servable) return null;

  const image = await dbWrite
    .selectFrom('Image as img')
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select(['img.ingestion', 'img.blockedFor', 'p.publishedAt'])
    .where('img.id', '=', imageId)
    .executeTakeFirst();
  if (!image) return `Image ${imageId} was not found.`;
  if (image.ingestion === 'Blocked' || image.blockedFor !== null) {
    return `Image ${imageId} is blocked and cannot be used.`;
  }
  if (!image.publishedAt || image.publishedAt > new Date()) {
    return `Image ${imageId} is not published, so Acolytes could not see it.`;
  }
  return `Image ${imageId} cannot be shown to Acolytes: it must be a rated image with no review hold.`;
}

export async function addCoreImage(input: {
  imageId: number;
  level: number;
  explanation: string;
}): Promise<Outcome> {
  const explanation = input.explanation.trim();
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  if (!explanation) return { ok: false, error: NEEDS_WHY };

  const problem = await unservableReason(input.imageId);
  if (problem) return { ok: false, error: problem };

  const now = utc(new Date());
  const answer = String(input.level);
  const existing = await dbWrite
    .selectFrom('KnightsReferenceImage')
    .select(['id', 'pool', 'source', 'status', 'answer'])
    .where('imageId', '=', input.imageId)
    .executeTakeFirst();
  if (existing?.pool === REFERENCE_POOL.hiddenCheck) {
    return { ok: false, error: 'This image is a hidden check, and an image is never in both.' };
  }
  if (existing?.source === REFERENCE_SOURCE.core && existing.status === REFERENCE_STATUS.active) {
    return { ok: false, error: 'This image is already in the core set.' };
  }

  if (existing) {
    // Guarded by the state just read, so a ruling or edit that landed since is not overwritten.
    const converted = await dbWrite
      .updateTable('KnightsReferenceImage')
      .set({
        source: REFERENCE_SOURCE.core,
        status: REFERENCE_STATUS.active,
        answer,
        explanation,
        updatedAt: now,
        ...keepCountsIf(answer),
      })
      .where('id', '=', existing.id)
      .where('pool', '=', REFERENCE_POOL.trials)
      .where('source', '=', existing.source)
      .where('status', '=', existing.status)
      .where('answer', '=', existing.answer)
      .executeTakeFirst();
    return Number(converted.numUpdatedRows) > 0
      ? { ok: true }
      : { ok: false, error: 'This image was changed by another moderator. Reload the page.' };
  }
  const inserted = await dbWrite
    .insertInto('KnightsReferenceImage')
    .values({
      imageId: input.imageId,
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
      pool: REFERENCE_POOL.trials,
      source: REFERENCE_SOURCE.core,
      status: REFERENCE_STATUS.active,
      answer,
      explanation,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('imageId').doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted
    ? { ok: true }
    : {
        ok: false,
        error:
          'This image was just added elsewhere, by another moderator or the harvest. Reload the page.',
      };
}

export async function updateCoreItem(input: {
  id: number;
  level: number;
  explanation: string;
}): Promise<Outcome> {
  const explanation = input.explanation.trim();
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  if (!explanation) return { ok: false, error: NEEDS_WHY };

  const answer = String(input.level);
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({ answer, explanation, updatedAt: utc(new Date()), ...keepCountsIf(answer) })
    .where('id', '=', input.id)
    .where('source', '=', REFERENCE_SOURCE.core)
    .where('status', '=', REFERENCE_STATUS.active)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

export async function retireReference(id: number): Promise<Outcome> {
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({ status: REFERENCE_STATUS.retired, updatedAt: utc(new Date()) })
    .where('id', '=', id)
    .where('pool', '=', REFERENCE_POOL.trials)
    .where('status', '=', REFERENCE_STATUS.active)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

/** One click: the item keeps its rating, joins the core set and stops being scored as fresh. */
export async function promoteToCore(input: { id: number; explanation: string }): Promise<Outcome> {
  const explanation = input.explanation.trim();
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({
      source: REFERENCE_SOURCE.core,
      explanation: explanation || null,
      updatedAt: utc(new Date()),
    })
    .where('id', '=', input.id)
    .where('source', '!=', REFERENCE_SOURCE.core)
    .where('pool', '=', REFERENCE_POOL.trials)
    .where('status', '=', REFERENCE_STATUS.active)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

/** Compared in SQL so the stored rating never reaches the page and the re-rate stays blind. */
export async function spotCheckItem(input: {
  id: number;
  level: number;
}): Promise<Outcome<{ agreed: boolean }>> {
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({
      status: sql<string>`CASE WHEN "answer" = ${String(input.level)} THEN ${
        REFERENCE_STATUS.active
      } ELSE ${REFERENCE_STATUS.retired} END`,
      updatedAt: utc(new Date()),
    })
    .where('id', '=', input.id)
    .where('pool', '=', REFERENCE_POOL.trials)
    .where('status', '=', REFERENCE_STATUS.pending)
    .returning(['status'])
    .executeTakeFirst();
  if (!updated) return { ok: false, error: GONE };
  return { ok: true, agreed: updated.status === REFERENCE_STATUS.active };
}
