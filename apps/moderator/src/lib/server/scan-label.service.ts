import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import {
  BLOCK_MAJORITY,
  DEFAULT_DAILY_QUOTA,
  LEASE_MS,
  VOTES_PER_ITEM,
  type ScanLabelFilters,
} from '$lib/scan-labels';

export type ScanLabelCard = {
  itemId: number;
  imageId: number;
  url: string;
  type: string;
  name: string | null;
  width: number | null;
  height: number | null;
  /** When this moderator's lease on the item runs out; a vote after it is accepted only while a slot is free. */
  leaseExpiresAt: Date;
};

export type VoteResult =
  | {
      ok: true;
      votes: number;
      blockVotes: number;
      /** This vote is the one that made a block the majority. Exactly one vote per item can be. */
      reachedBlockMajority: boolean;
      decided: boolean;
    }
  | { ok: false; reason: 'not-open' | 'already-voted' | 'full' };

type Db = Kysely<DB> | Transaction<DB>;

const dayBounds = (day: string) => {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
};

export const utcDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function openItems(db: Db, filters: ScanLabelFilters) {
  let q = db.selectFrom('ScanLabelItem as i').where('i.status', '=', 'open');
  if (filters.day) {
    const { start, end } = dayBounds(filters.day);
    q = q.where('i.firstFlaggedAt', '>=', start).where('i.firstFlaggedAt', '<', end);
  }
  if (filters.flaggerVersion) {
    const version = filters.flaggerVersion;
    q = q.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('ScanLabelFlag as f')
          .select(sql`1`.as('one'))
          .whereRef('f.itemId', '=', 'i.id')
          .where('f.flaggerVersion', '=', version)
      )
    );
  }
  return q;
}

/** Live leases held on an item by moderators other than `userId`. */
const otherLiveLeases = (db: Db, itemId: number, userId: number, now: Date) =>
  db
    .selectFrom('ScanLabelClaim')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('itemId', '=', itemId)
    .where('userId', '!=', userId)
    .where('expiresAt', '>', now)
    .executeTakeFirstOrThrow()
    .then((r) => Number(r.n));

async function toCard(db: Db, itemId: number, leaseExpiresAt: Date): Promise<ScanLabelCard | null> {
  const row = await db
    .selectFrom('ScanLabelItem as i')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .select([
      'i.id as itemId',
      'i.imageId',
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

/**
 * Serve this moderator one item and hold a vote slot on it for `LEASE_MS`.
 *
 * A moderator with a live lease on an open item gets that item back, so a reload cannot pile up
 * leases. Otherwise partly-voted items come first, then newest.
 */
export async function claimNext(
  userId: number,
  filters: ScanLabelFilters,
  now: Date = new Date()
): Promise<ScanLabelCard | null> {
  return dbWrite.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom('ScanLabelClaim as c')
      .innerJoin('ScanLabelItem as i', 'i.id', 'c.itemId')
      .select(['c.itemId', 'c.expiresAt'])
      .where('c.userId', '=', userId)
      .where('c.expiresAt', '>', now)
      .where('i.status', '=', 'open')
      .orderBy('c.expiresAt', 'desc')
      .executeTakeFirst();
    if (held) return toCard(trx, held.itemId, held.expiresAt);

    const tried: number[] = [];
    // Bounded: each pass either leases an item or retires one that filled up under us.
    for (let attempt = 0; attempt < 20; attempt++) {
      let q = openItems(trx, filters)
        .select(['i.id', 'i.votes'])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('ScanLabelVote as v')
                .select(sql`1`.as('one'))
                .whereRef('v.itemId', '=', 'i.id')
                .where('v.userId', '=', userId)
            )
          )
        )
        .where(
          (eb) =>
            eb(
              'i.votes',
              '+',
              eb
                .selectFrom('ScanLabelClaim as c')
                .select((e) => e.fn.countAll<number>().as('n'))
                .whereRef('c.itemId', '=', 'i.id')
                .where('c.userId', '!=', userId)
                .where('c.expiresAt', '>', now)
            ),
          '<',
          VOTES_PER_ITEM
        );
      if (tried.length) q = q.where('i.id', 'not in', tried);
      const candidate = await q
        .orderBy('i.votes', 'desc')
        .orderBy('i.firstFlaggedAt', 'desc')
        .orderBy('i.id', 'asc')
        .limit(1)
        .forUpdate('i')
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return null;

      // 🔴 Re-count AFTER taking the row lock, in a new statement. The candidate query's lease count
      // came from a snapshot that can predate a rival claimer's commit; every claimer and voter takes
      // this lock first, so only a count read under it is current.
      const fresh = await trx
        .selectFrom('ScanLabelItem')
        .select(['votes', 'status'])
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      const leases = await otherLiveLeases(trx, candidate.id, userId, now);
      if (fresh.status !== 'open' || fresh.votes + leases >= VOTES_PER_ITEM) {
        tried.push(candidate.id);
        continue;
      }

      const expiresAt = new Date(now.getTime() + LEASE_MS);
      await trx
        .insertInto('ScanLabelClaim')
        .values({ itemId: candidate.id, userId, expiresAt })
        .onConflict((oc) => oc.columns(['itemId', 'userId']).doUpdateSet({ expiresAt }))
        .execute();
      const card = await toCard(trx, candidate.id, expiresAt);
      if (card) return card;
      tried.push(candidate.id);
    }
    return null;
  });
}

/**
 * Record one moderator's vote. Votes run to `VOTES_PER_ITEM` even after a block majority, so the
 * label records whether the moderators agreed.
 */
export async function castVote(
  {
    itemId,
    userId,
    block,
    msOnItem,
  }: { itemId: number; userId: number; block: boolean; msOnItem: number | null },
  now: Date = new Date()
): Promise<VoteResult> {
  return dbWrite.transaction().execute(async (trx): Promise<VoteResult> => {
    const item = await trx
      .selectFrom('ScanLabelItem')
      .select(['votes', 'blockVotes', 'status'])
      .where('id', '=', itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!item || item.status !== 'open' || item.votes >= VOTES_PER_ITEM)
      return { ok: false, reason: 'not-open' };

    const mine = await trx
      .selectFrom('ScanLabelClaim')
      .select('expiresAt')
      .where('itemId', '=', itemId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    const holdsLiveLease = !!mine && mine.expiresAt > now;
    if (!holdsLiveLease) {
      const leases = await otherLiveLeases(trx, itemId, userId, now);
      if (item.votes + leases >= VOTES_PER_ITEM) return { ok: false, reason: 'full' };
    }

    const inserted = await trx
      .insertInto('ScanLabelVote')
      .values({ itemId, userId, block, msOnItem, createdAt: now })
      .onConflict((oc) => oc.columns(['itemId', 'userId']).doNothing())
      .executeTakeFirst();
    if (!inserted.numInsertedOrUpdatedRows) return { ok: false, reason: 'already-voted' };

    const votes = item.votes + 1;
    const blockVotes = item.blockVotes + (block ? 1 : 0);
    const decided = votes === VOTES_PER_ITEM;
    const updated = await trx
      .updateTable('ScanLabelItem')
      .set({
        votes,
        blockVotes,
        ...(decided && {
          status: 'decided',
          outcome: blockVotes >= BLOCK_MAJORITY ? 'block' : 'clear',
          unanimous: blockVotes === 0 || blockVotes === VOTES_PER_ITEM,
          decidedAt: now,
        }),
      })
      .where('id', '=', itemId)
      .executeTakeFirst();
    if (!updated.numUpdatedRows) throw new Error(`scan label item ${itemId} vanished mid-vote`);

    await trx
      .deleteFrom('ScanLabelClaim')
      .where('itemId', '=', itemId)
      .where('userId', '=', userId)
      .execute();

    return {
      ok: true,
      votes,
      blockVotes,
      reachedBlockMajority: block && blockVotes === BLOCK_MAJORITY,
      decided,
    };
  });
}

export type ScanLabelCounters = {
  openInFilter: number;
  myVotesToday: number;
  myQuota: number;
  decidedToday: number;
};

export async function getCounters(
  userId: number,
  filters: ScanLabelFilters,
  now: Date = new Date(),
  db: Kysely<DB> = dbRead
): Promise<ScanLabelCounters> {
  const today = utcDayStart(now);
  const [open, mine, quota, decided] = await Promise.all([
    openItems(db, filters)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('ScanLabelVote')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('userId', '=', userId)
      .where('createdAt', '>=', today)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('ScanLabelQuota')
      .select('dailyVotes')
      .where('userId', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('ScanLabelItem')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('decidedAt', '>=', today)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    openInFilter: Number(open.n),
    myVotesToday: Number(mine.n),
    myQuota: quota?.dailyVotes ?? DEFAULT_DAILY_QUOTA,
    decidedToday: Number(decided.n),
  };
}

/** Flagger versions that have at least one open item, newest flag first, for the filter. */
export async function getOpenFlaggerVersions(db: Kysely<DB> = dbRead): Promise<string[]> {
  const rows = await db
    .selectFrom('ScanLabelFlag as f')
    .innerJoin('ScanLabelItem as i', 'i.id', 'f.itemId')
    .select('f.flaggerVersion')
    .select((eb) => eb.fn.max('f.flaggedAt').as('latest'))
    .where('i.status', '=', 'open')
    .groupBy('f.flaggerVersion')
    .orderBy('latest', 'desc')
    .execute();
  return rows.map((r) => r.flaggerVersion);
}
