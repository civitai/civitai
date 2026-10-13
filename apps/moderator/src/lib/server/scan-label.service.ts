import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import {
  BLOCK_MAJORITY,
  dayBounds,
  effectiveQuota,
  LEASE_MS,
  utcDayStart,
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

const MAX_CLAIM_ATTEMPTS = 20;

/**
 * A live lease on an open item in the current filter is returned as-is, so a reload cannot pile up
 * leases. A live lease outside the filter is released.
 */
export async function claimNext(
  userId: number,
  filters: ScanLabelFilters,
  now: Date = new Date()
): Promise<ScanLabelCard | null> {
  return dbWrite.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom('ScanLabelClaim as c')
      .select(['c.itemId', 'c.expiresAt'])
      .where('c.userId', '=', userId)
      .where('c.expiresAt', '>', now)
      .orderBy('c.expiresAt', 'desc')
      .execute();
    for (const lease of held) {
      const inView = await openItems(trx, filters)
        .select('i.id')
        .where('i.id', '=', lease.itemId)
        .executeTakeFirst();
      if (inView) return toCard(trx, lease.itemId, lease.expiresAt);
    }
    if (held.length)
      await trx
        .deleteFrom('ScanLabelClaim')
        .where('userId', '=', userId)
        .where(
          'itemId',
          'in',
          held.map((l) => l.itemId)
        )
        .execute();

    const tried: number[] = [];
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
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

// Reads the primary: it runs straight after a vote, and a lagging replica shows the count one behind.
export async function getCounters(
  userId: number,
  filters: ScanLabelFilters,
  now: Date = new Date(),
  db: Kysely<DB> = dbWrite
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
    myQuota: effectiveQuota(quota),
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

export type SweepResult = {
  blocked: number[];
  skipped: { itemId: number; result: 'already-blocked' | 'image-missing' }[];
  failed: { itemId: number; error: string }[];
};

/** A claim older than this is presumed dead (a crash mid-block) and may be taken again. */
export const ACTION_CLAIM_MS = 5 * 60_000;

/** Reads stored state, not the triggering vote, so a failed or interrupted block is retried by the
 *  next sweep. */
export async function applyMajorityBlocks(
  {
    requester,
    ip,
    userAgent,
    limit = 10,
  }: { requester?: number; ip?: string; userAgent?: string; limit?: number },
  block: (args: BlockImageArgs) => Promise<void>,
  now: Date = new Date()
): Promise<SweepResult> {
  const staleBefore = new Date(now.getTime() - ACTION_CLAIM_MS);
  const pending = await dbWrite
    .selectFrom('ScanLabelItem')
    .select(['id', 'imageId'])
    .where('blockVotes', '>=', BLOCK_MAJORITY)
    .where('status', '!=', 'void')
    .where('actionedAt', 'is', null)
    .where((eb) =>
      eb.or([eb('actionStartedAt', 'is', null), eb('actionStartedAt', '<', staleBefore)])
    )
    // Items that keep failing go last, so they cannot starve newer majorities.
    .orderBy(sql`"actionError" IS NOT NULL`)
    .orderBy('id')
    .limit(limit)
    .execute();

  const result: SweepResult = { blocked: [], skipped: [], failed: [] };
  for (const item of pending) {
    // Claim first: concurrent sweeps must not double-block.
    const claimed = await dbWrite
      .updateTable('ScanLabelItem')
      .set({ actionStartedAt: now })
      .where('id', '=', item.id)
      .where('actionedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('actionStartedAt', 'is', null), eb('actionStartedAt', '<', staleBefore)])
      )
      .executeTakeFirst();
    if (!claimed.numUpdatedRows) continue;

    try {
      const image = await dbWrite
        .selectFrom('Image')
        .select('ingestion')
        .where('id', '=', item.imageId)
        .executeTakeFirst();
      // Blocking an already-blocked image would notify its owner a second time.
      const outcome = !image
        ? ('image-missing' as const)
        : image.ingestion === 'Blocked'
        ? ('already-blocked' as const)
        : ('blocked' as const);

      if (outcome === 'blocked') {
        const actor = await dbWrite
          .selectFrom('ScanLabelVote')
          .select('userId')
          .where('itemId', '=', item.id)
          .where('block', '=', true)
          .orderBy('createdAt')
          .orderBy('userId')
          .offset(BLOCK_MAJORITY - 1)
          .limit(1)
          .executeTakeFirstOrThrow();
        await block({
          imageId: item.imageId,
          userId: actor.userId,
          ...(actor.userId === requester && { ip, userAgent }),
          violationDetails: 'Scan label majority',
        });
        result.blocked.push(item.id);
      } else {
        result.skipped.push({ itemId: item.id, result: outcome });
      }
      await dbWrite
        .updateTable('ScanLabelItem')
        .set({ actionedAt: new Date(), actionResult: outcome, actionError: null })
        .where('id', '=', item.id)
        .execute();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('scan label block failed', { itemId: item.id, error: message });
      result.failed.push({ itemId: item.id, error: message });
      await dbWrite
        .updateTable('ScanLabelItem')
        .set({ actionStartedAt: null, actionError: message.slice(0, 500) })
        .where('id', '=', item.id)
        .execute()
        .catch(() => undefined);
    }
  }
  return result;
}

export type BlockImageArgs = {
  imageId: number;
  userId: number;
  ip?: string;
  userAgent?: string;
  violationDetails?: string;
};
