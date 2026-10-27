import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { validNsfwLevels } from '@civitai/shared';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from '../db';
import { CONFIRM_LEASE_MS } from './constants';

type Db = Kysely<DB> | Transaction<DB>;

export type ConfirmCard = {
  itemId: number;
  imageId: number;
  token: string;
  url: string;
  type: string;
  name: string | null;
  width: number | null;
  height: number | null;
  leaseExpiresAt: Date;
};

export type AnswerResult =
  | { ok: true; outcome: 'agreed' | 'disagreed' }
  | { ok: false; reason: 'not-yours' | 'expired' | 'not-open' | 'own-rating' | 'invalid-level' };

/** Levels a moderator can rate an image at here; blocking an image is not a rating. */
export const isConfirmLevel = (level: number) => validNsfwLevels.has(level);

/** True when a new item was queued; false when the image already has one open or the level is not ratable. */
export async function enqueueConfirm(
  {
    imageId,
    level,
    modId,
    at = new Date(),
  }: { imageId: number; level: number; modId: number; at?: Date },
  db: Db = dbWrite
): Promise<boolean> {
  if (!isConfirmLevel(level)) return false;
  const inserted = await db
    .insertInto('NewOrderConfirmItem')
    .values({ imageId, firstLevel: level, firstModId: modId, firstSetAt: at })
    .onConflict((oc) => oc.column('imageId').where('status', '=', 'open').doNothing())
    .executeTakeFirst();
  return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
}

const MAX_CLAIM_ATTEMPTS = 10;

/** Selects only what the card shows: never `firstLevel`, `firstModId` or `Image.nsfwLevel`. */
async function toCard(
  db: Db,
  itemId: number,
  userId: number,
  leaseExpiresAt: Date
): Promise<ConfirmCard | null> {
  const row = await db
    .selectFrom('NewOrderConfirmItem as i')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .innerJoin('NewOrderConfirmClaim as c', (j) =>
      j.onRef('c.itemId', '=', 'i.id').on('c.userId', '=', userId)
    )
    .select([
      'i.id as itemId',
      'i.imageId',
      'c.token',
      'img.url',
      'img.type',
      'img.name',
      'img.width',
      'img.height',
    ])
    .where('i.id', '=', itemId)
    .executeTakeFirst();
  return row ? { ...row, type: String(row.type), leaseExpiresAt } : null;
}

const otherLiveLeases = (db: Db, itemId: number, userId: number, now: Date) =>
  db
    .selectFrom('NewOrderConfirmClaim')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('itemId', '=', itemId)
    .where('userId', '!=', userId)
    .where('expiresAt', '>', now)
    .executeTakeFirstOrThrow()
    .then((r) => Number(r.n));

/**
 * The item the moderator holds a live lease on, else the oldest open one they may rate: not their
 * own rating, not an image they answered on an earlier item, and not leased to another moderator.
 */
export async function claimNext(
  userId: number,
  now: Date = new Date()
): Promise<ConfirmCard | null> {
  return dbWrite.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom('NewOrderConfirmClaim as c')
      .innerJoin('NewOrderConfirmItem as i', 'i.id', 'c.itemId')
      .select(['c.itemId', 'c.expiresAt'])
      .where('c.userId', '=', userId)
      .where('c.expiresAt', '>', now)
      .where('i.status', '=', 'open')
      .where('i.firstModId', '!=', userId)
      .orderBy('c.expiresAt', 'desc')
      .executeTakeFirst();
    if (held) return toCard(trx, held.itemId, userId, held.expiresAt);

    const tried: number[] = [];
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      let q = trx
        .selectFrom('NewOrderConfirmItem as i')
        .innerJoin('Image as img', 'img.id', 'i.imageId')
        .select('i.id')
        .where('i.status', '=', 'open')
        .where('i.firstModId', '!=', userId)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('NewOrderConfirmItem as prior')
                .select(sql`1`.as('one'))
                .whereRef('prior.imageId', '=', 'i.imageId')
                .where('prior.secondModId', '=', userId)
            )
          )
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('NewOrderConfirmClaim as c')
                .select(sql`1`.as('one'))
                .whereRef('c.itemId', '=', 'i.id')
                .where('c.userId', '!=', userId)
                .where('c.expiresAt', '>', now)
            )
          )
        );
      if (tried.length) q = q.where('i.id', 'not in', tried);
      const candidate = await q
        .orderBy('i.firstSetAt', 'asc')
        .orderBy('i.id', 'asc')
        .limit(1)
        .forUpdate('i')
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return null;

      // 🔴 Re-check under the row lock: the candidate query's snapshot can predate a rival
      // claimer's commit, and every claimer and answerer takes this lock first.
      const fresh = await trx
        .selectFrom('NewOrderConfirmItem')
        .select('status')
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      if (fresh.status !== 'open' || (await otherLiveLeases(trx, candidate.id, userId, now)) > 0) {
        tried.push(candidate.id);
        continue;
      }

      const expiresAt = new Date(now.getTime() + CONFIRM_LEASE_MS);
      await trx
        .insertInto('NewOrderConfirmClaim')
        .values({ itemId: candidate.id, userId, expiresAt })
        .onConflict((oc) => oc.columns(['itemId', 'userId']).doUpdateSet({ expiresAt }))
        .execute();
      const card = await toCard(trx, candidate.id, userId, expiresAt);
      if (card) return card;
      tried.push(candidate.id);
    }
    return null;
  });
}

/** The item a card's token stands for, for the moderator it was minted for; null for anyone else. */
export async function itemForToken(
  token: string,
  userId: number,
  now: Date = new Date()
): Promise<number | null> {
  const claim = await dbWrite
    .selectFrom('NewOrderConfirmClaim')
    .select('itemId')
    .where('token', '=', token)
    .where('userId', '=', userId)
    .where('expiresAt', '>', now)
    .executeTakeFirst();
  return claim?.itemId ?? null;
}

/**
 * The second moderator's blind rating. The same level agrees and queues the image for the Acolyte
 * pool (the main app's confirm job reads `status = 'agreed'`); any other level drops the item.
 */
export async function answerConfirm(
  { token, userId, level }: { token: string; userId: number; level: number },
  now: Date = new Date()
): Promise<AnswerResult> {
  if (!isConfirmLevel(level)) return { ok: false, reason: 'invalid-level' };
  return dbWrite.transaction().execute(async (trx): Promise<AnswerResult> => {
    const claim = await trx
      .selectFrom('NewOrderConfirmClaim')
      .select(['itemId', 'expiresAt'])
      .where('token', '=', token)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!claim) return { ok: false, reason: 'not-yours' };
    if (claim.expiresAt <= now) return { ok: false, reason: 'expired' };

    const item = await trx
      .selectFrom('NewOrderConfirmItem')
      .select(['status', 'firstLevel', 'firstModId'])
      .where('id', '=', claim.itemId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (item.status !== 'open') return { ok: false, reason: 'not-open' };
    if (item.firstModId === userId) return { ok: false, reason: 'own-rating' };

    const outcome = item.firstLevel === level ? 'agreed' : 'disagreed';
    await trx
      .updateTable('NewOrderConfirmItem')
      .set({ status: outcome, secondLevel: level, secondModId: userId, secondAt: now })
      .where('id', '=', claim.itemId)
      .where('status', '=', 'open')
      .execute();
    return { ok: true, outcome };
  });
}
