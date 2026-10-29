import { sql, utc } from '@civitai/db/kysely';
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
  harvestedAt: Date;
};

/** A pending item as the spot-check shows it: the stored rating is withheld so the re-rate is blind. */
export type SpotCheckItem = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  harvestedAt: Date;
};

export type Outcome = { ok: true } | { ok: false; error: string };

const isFlagged = (
  { answers, failures }: { answers: number; failures: number },
  config: CoreSetConfig
) => answers >= config.flagMinAnswers && failures / answers >= config.flagFailureRate;

function references() {
  return dbWrite
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .where('r.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION);
}

const listColumns = [
  'r.id',
  'r.imageId',
  'r.source',
  'r.status',
  'r.answer',
  'r.explanation',
  'r.answers',
  'r.failures',
  'r.harvestedAt',
  'img.url as imageKey',
  'img.name as imageName',
] as const;

const withFlag = <T extends { answers: number; failures: number }>(
  rows: T[],
  config: CoreSetConfig
) => rows.map((row) => ({ ...row, flagged: isFlagged(row, config) }));

/** Active core items first, then retired ones, so a retired item can be found and added back. */
export async function getCoreItems(config: CoreSetConfig = CORESET): Promise<CoreSetItem[]> {
  const rows = await references()
    .select([...listColumns])
    .where('r.source', '=', 'core')
    .orderBy(sql`("r"."status" = 'active')`, 'desc')
    .orderBy('r.id', 'asc')
    .limit(config.listLimit)
    .execute();
  return withFlag(rows, config);
}

/** Fresh items in the Trials pool, flagged ones first. */
export async function getFreshItems(config: CoreSetConfig = CORESET): Promise<CoreSetItem[]> {
  const rows = await references()
    .select([...listColumns])
    .where('r.source', '!=', 'core')
    .where('r.pool', '=', 'trials')
    .where('r.status', '=', 'active')
    .orderBy('r.harvestedAt', 'desc')
    .orderBy('r.id', 'desc')
    .limit(config.listLimit)
    .execute();
  return withFlag(rows, config).sort((a, b) => Number(b.flagged) - Number(a.flagged));
}

export async function getSpotCheckItems(config: CoreSetConfig = CORESET): Promise<SpotCheckItem[]> {
  return references()
    .select(['r.id', 'r.imageId', 'r.harvestedAt', 'img.url as imageKey', 'img.name as imageName'])
    .where('r.pool', '=', 'trials')
    .where('r.status', '=', 'pending')
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
  return {
    core: sum((r) => r.source === 'core' && r.status === 'active'),
    fresh: sum((r) => r.source !== 'core' && r.pool === 'trials' && r.status === 'active'),
    spotCheck: sum((r) => r.pool === 'trials' && r.status === 'pending'),
  };
}

const BAD_LEVEL = 'Pick a rating level.';
const NEEDS_WHY = 'Explain why the image has this rating; Acolytes see it after they answer.';
const GONE = 'This item is no longer available. Reload the page.';

const cleanWhy = (explanation: string) => explanation.trim();
const validLevel = (level: number) => Number.isInteger(level) && isRatingLevel(level);

/** An image whose rating a moderator may teach: published, rated and not blocked. */
async function checkImage(imageId: number): Promise<string | null> {
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
  return null;
}

export async function addCoreImage(input: {
  imageId: number;
  level: number;
  explanation: string;
}): Promise<Outcome> {
  const explanation = cleanWhy(input.explanation);
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  if (!explanation) return { ok: false, error: NEEDS_WHY };

  const imageProblem = await checkImage(input.imageId);
  if (imageProblem) return { ok: false, error: imageProblem };

  const now = utc(new Date());
  const existing = await dbWrite
    .selectFrom('KnightsReferenceImage')
    .select(['id', 'pool', 'source', 'status'])
    .where('imageId', '=', input.imageId)
    .executeTakeFirst();
  if (existing?.pool === 'hiddenCheck') {
    return { ok: false, error: 'This image is a hidden check, and an image is never in both.' };
  }
  if (existing?.source === 'core' && existing.status === 'active') {
    return { ok: false, error: 'This image is already in the core set.' };
  }

  const values = { source: 'core', status: 'active', answer: String(input.level), explanation };
  if (existing) {
    await dbWrite
      .updateTable('KnightsReferenceImage')
      .set({ ...values, updatedAt: now })
      .where('id', '=', existing.id)
      .execute();
    return { ok: true };
  }
  const inserted = await dbWrite
    .insertInto('KnightsReferenceImage')
    .values({
      ...values,
      imageId: input.imageId,
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
      pool: 'trials',
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('imageId').doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted
    ? { ok: true }
    : { ok: false, error: 'Another moderator just added this image. Reload the page.' };
}

export async function updateCoreItem(input: {
  id: number;
  level: number;
  explanation: string;
}): Promise<Outcome> {
  const explanation = cleanWhy(input.explanation);
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  if (!explanation) return { ok: false, error: NEEDS_WHY };

  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({ answer: String(input.level), explanation, updatedAt: utc(new Date()) })
    .where('id', '=', input.id)
    .where('source', '=', 'core')
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

export async function retireReference(id: number): Promise<Outcome> {
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({ status: 'retired', updatedAt: utc(new Date()) })
    .where('id', '=', id)
    .where('status', '!=', 'retired')
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

/** One click: the item keeps its rating, joins the core set and stops being scored as fresh. */
export async function promoteToCore(input: { id: number; explanation: string }): Promise<Outcome> {
  const explanation = cleanWhy(input.explanation);
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({ source: 'core', explanation: explanation || null, updatedAt: utc(new Date()) })
    .where('id', '=', input.id)
    .where('source', '!=', 'core')
    .where('pool', '=', 'trials')
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

/**
 * Agreement lets the item into Trials; disagreement retires it so it stays out. The stored rating is
 * compared here and never sent to the page, so the moderator cannot see it while deciding.
 */
export async function spotCheckItem(input: {
  id: number;
  level: number;
}): Promise<{ ok: true; agreed: boolean } | { ok: false; error: string }> {
  if (!validLevel(input.level)) return { ok: false, error: BAD_LEVEL };
  const now = utc(new Date());
  const updated = await dbWrite
    .updateTable('KnightsReferenceImage')
    .set({
      status: sql<string>`CASE WHEN "answer" = ${String(
        input.level
      )} THEN 'active' ELSE 'retired' END`,
      updatedAt: now,
    })
    .where('id', '=', input.id)
    .where('pool', '=', 'trials')
    .where('status', '=', 'pending')
    .returning(['status'])
    .executeTakeFirst();
  if (!updated) return { ok: false, error: GONE };
  return { ok: true, agreed: updated.status === 'active' };
}
