import type { Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { logToAxiom } from './axiom';
import { getRedis } from './redis';

// Owns the Blocklist table AND the shared Redis key the main app reads. Writers BUST that key rather
// than rewriting it, so a main-app validator repopulates from the table on its next read.

export type BlocklistDTO = { id?: number; type: string; data: string[] };

/**
 * A CEILING on staleness, not a cache lifetime — writers delete this key, so an edit normally takes
 * effect on the next read. The populate below is read-then-write, so a reader that read the row
 * before a write commits can land its pre-write snapshot after that write's delete, and only
 * another write to the same type clears it. Three of the eight lists in production had gone 8, 46
 * and 676 days without a write (measured 2026-08-25), so the expiry was the only bound there was.
 *
 * The main app and the auth hub populate this same key with the same value; they have to agree.
 */
const CACHE_TTL = 5 * 60;

const blocklistKey = (type: string) =>
  `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;

/** The cache-aside populate, and the ONLY `set` in this file — see `bustCache` for why writers never. */
async function setCache(data: BlocklistDTO) {
  await getRedis().set(blocklistKey(data.type), JSON.stringify(data), { EX: CACHE_TTL });
}

/**
 * 🔴 DELETE, never a re-read written back. Writing a snapshot is itself a read-modify-write with no
 * lock over it, so two WRITERS the row lock correctly serialised could still land their cache
 * writes in the other order and leave the LOSER's list cached until it expires. Deletes commute with each
 * other, so that ordering no longer decides anything.
 *
 * ⚠️ What this does NOT close, stated because the obvious reading of "deletes commute" is that it
 * does: a DELETE does not commute with the POPULATE in `getBlocklistDTO`, which is plain
 * cache-aside. A reader that missed and read the row before the commit can `set` its pre-write
 * snapshot AFTER the bust, pinning it for the whole month TTL.
 *
 * The causation runs to the NEXT write, not this one: a bust guarantees the following read misses,
 * and the page reloads through `load` on every submit, so a reader is typically mid-fill when the
 * write AFTER this one commits — two moderators submitting seconds apart is enough. This write's
 * own bust cannot put a reader into this write's window, because a miss it caused reads a row that
 * is already updated. `CACHE_TTL` is the TTL-short-enough option: it bounds that window rather than closing it.
 *
 * Returns false rather than throwing. The row is already committed by the time this runs, and a
 * throw here reports failure for a write that succeeded — on the remove path the operator's retry
 * then finds the entry gone, gets "Nothing was removed", reloads, and sees the chip still there
 * because the stale cache is what serves the page. Same rule as `a04fa6a608` on the session cache.
 */
async function bustCache(type: string): Promise<boolean> {
  try {
    await getRedis().del(blocklistKey(type));
    return true;
  } catch (error) {
    void logToAxiom({
      name: 'blocklist-cache-bust-failed',
      type: 'error',
      message: 'Blocklist row was written but its cache key was not cleared; readers stay stale',
      details: {
        blocklistType: type,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}

/**
 * Nothing stops a type having more than one row, and `EmailDomain` had two in production —
 * 8292 entries against 3, with the smaller row's domains present nowhere else. `limit(1)` with
 * no `orderBy` let Postgres decide which one was enforced, and the loser's entries were simply
 * not applied. Reads the lowest id, always, and reports the duplicate.
 *
 * Deliberately NOT a union: for a deny-list a union blocks more, but for the benign-phrase
 * lists a union strips more, which is a moderation bypass — one helper cannot pick a safe
 * direction for both. Mirrors `readBlocklistRow` in the main app's `blocklist.service.ts`;
 * both must agree, because they read and write the SAME Redis key.
 */
async function readBlocklistRow(type: string): Promise<BlocklistDTO> {
  // `dbWrite`, not `dbRead`, and this is MORE load-bearing since the writers stopped calling this:
  // its one caller is the cache-aside populate in `getBlocklistDTO`, and a write busts the key, so
  // the very next read is a post-write read whose value then serves every pod until it expires. Off
  // the replica that read races replication and caches the PRE-EDIT row — a moderator's change silently
  // undone. Do not "optimise" this to `dbRead` because no write path reaches it any more.
  const rows = await dbWrite
    .selectFrom('Blocklist')
    .select(['id', 'type', 'data'])
    .where('type', '=', type)
    .orderBy('id', 'asc')
    .execute();

  if (rows.length > 1) {
    // Axiom rather than console: this is a standing data anomaly no moderator will ever see,
    // not a failure attached to an action in flight. Same `name` as the main app's report so
    // the same anomaly from either app is one searchable thing.
    void logToAxiom({
      name: 'blocklist-duplicate-rows',
      type: 'error',
      message:
        'More than one Blocklist row for a type; entries on the ignored rows are not enforced',
      details: {
        blocklistType: type,
        usedId: rows[0].id,
        ignoredIds: rows.slice(1).map((row) => row.id),
        ignoredEntryCounts: rows.slice(1).map((row) => row.data.length),
      },
    });
  }

  // 🔴 The absent-row fallback carries NO `id`, and that is load-bearing across two apps: the
  // main app's `getClientBenignLists` reads `row.id == null` as "no moderator row yet, fall back
  // to the list shipped in the bundle". This value reaches it through the shared Redis key, so
  // adding an `id` here — or caching a synthesised row — would silently flip every browser from
  // the moderator's list to the bundled one, with nothing failing.
  return rows[0] ?? { type, data: [] };
}

export async function getBlocklistDTO({ type }: { type: string }): Promise<BlocklistDTO> {
  const cached = await getRedis().get(blocklistKey(type));
  if (cached) return JSON.parse(cached) as BlocklistDTO;

  const result = await readBlocklistRow(type);

  await setCache(result);
  return result;
}

export class BlocklistRowMismatchError extends Error {
  constructor() {
    super('That blocklist row does not belong to this type.');
    this.name = 'BlocklistRowMismatchError';
  }
}

/** What a write did, and whether readers will see it before the month TTL expires. */
export type BlocklistWriteResult = { count: number; cacheStale: boolean };

/** What the transaction changed, and which row it changed — `recordModActivity` needs the row id.
 *  Absent when a submitted id matched no row of the type: the id names no row there, so it must not
 *  be reached for as a stand-in. */
type Written = { count: number; rowId: number };

/**
 * Adds entries, returning how many the row actually GAINED — not how many were submitted. Since
 * both branches dedupe, re-adding entries that are already on the list changes nothing, and the
 * page reporting the submitted count is the same "the screen says it happened" defect the removal
 * count was fixed for.
 *
 * Throws `BlocklistRowMismatchError` when `id` names no row of `type`.
 */
export async function upsertBlocklist({
  id,
  type,
  blocklist,
  userId,
}: {
  id?: number;
  type: string;
  blocklist: string[];
  userId: number;
}): Promise<BlocklistWriteResult> {
  const items = [
    ...new Set(blocklist.map((item) => item.toLowerCase()).filter((x) => x.length > 0)),
  ];

  // One transaction with a locked read, because the merge is read-modify-write over the WHOLE
  // array: two overlapping edits each computed their merge from the same pre-state and the later
  // write restored what the earlier one dropped, both reporting success. The other writer is the
  // main app's weekly cron, editing this same column through its own client, so the lock has to be
  // in the database rather than in either app.
  const added = await dbWrite.transaction().execute(async (trx): Promise<Written | undefined> => {
    const existing = await readRowForWrite(trx, type, id);

    if (!existing) {
      // An `id` that names no row of this type is a stale tab or a hand-crafted post. Refuse; do
      // NOT fall through to an insert, which would add a second row for the type.
      if (id !== undefined) return undefined;
      const inserted = await trx
        .insertInto('Blocklist')
        .values({ type, data: items, updatedAt: new Date() })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      return { count: items.length, rowId: inserted.id };
    }

    const next = [...new Set([...existing.data, ...items])];
    const gained = next.length - existing.data.length;
    if (gained === 0) return { count: 0, rowId: existing.id };

    await trx
      .updateTable('Blocklist')
      .set({ data: next, updatedAt: new Date() })
      // `type` here as well as on the read. It is redundant while both run under one lock, and it
      // is the predicate that still holds if anyone later moves either statement out.
      .where('id', '=', existing.id)
      .where('type', '=', type)
      .executeTakeFirstOrThrow();
    return { count: gained, rowId: existing.id };
  });

  if (added === undefined) throw new BlocklistRowMismatchError();
  if (added.count === 0) return { count: 0, cacheStale: false };

  const cacheStale = !(await bustCache(type));
  await recordModActivity({
    userId,
    entityType: 'blocklist',
    entityId: added.rowId,
    activity: 'add',
  });
  return { count: added.count, cacheStale };
}

/**
 * Returns how many entries were actually dropped, which is NOT the number submitted: a stale `id`
 * (the DTO is Redis-cached for a month), an `id` belonging to another type, an entry already gone,
 * or one stored in a case the lowercased needle cannot match all end in zero. The page reports this
 * number, so "Removed 1 item." above a chip that is still there is a state the UI can no longer
 * reach.
 */
export async function removeBlocklistItems({
  id,
  type,
  items,
  userId,
}: {
  id: number;
  type: string;
  items: string[];
  userId: number;
}): Promise<BlocklistWriteResult> {
  const lower = items.map((x) => x.toLowerCase());

  // Same lock and the same reason as `upsertBlocklist`: without it two chips removed in quick
  // succession each filtered the same pre-state and the second write put the first one back.
  const removed = await dbWrite.transaction().execute(async (trx): Promise<Written | undefined> => {
    const row = await readRowForWrite(trx, type, id);
    // `undefined` means a quiet zero here, and a thrown `BlocklistRowMismatchError` in
    // `upsertBlocklist` — same signature, opposite reading. Deliberate: the remove action turns a
    // zero into its own 409, and has no try/catch, so copying upsert's `throw` guard across turns
    // that message into a 500.
    if (!row) return undefined;

    const filtered = row.data.filter((item) => !lower.includes(item));
    const count = row.data.length - filtered.length;
    if (count === 0) return { count: 0, rowId: row.id };

    await trx
      .updateTable('Blocklist')
      .set({ data: filtered, updatedAt: new Date() })
      .where('id', '=', row.id)
      .where('type', '=', type)
      .executeTakeFirstOrThrow();
    return { count, rowId: row.id };
  });

  if (!removed || removed.count === 0) return { count: 0, cacheStale: false };

  const cacheStale = !(await bustCache(type));
  await recordModActivity({
    userId,
    entityType: 'blocklist',
    entityId: removed.rowId,
    activity: 'remove',
  });
  return { count: removed.count, cacheStale };
}

/**
 * The row a write is about to edit, locked until the transaction commits.
 *
 * Scoped to `type` always, and to `id` only when one was submitted. Both arrive as independent
 * form fields, so filtering on the id alone let one type's entries be merged into another type's
 * row — benign phrases into a deny list, phishing patterns into the email-domain list. With no id
 * it takes the LOWEST row of the type, the same one `readBlocklistRow` enforces, so an add from a
 * tab whose type has no row yet cannot append to a row nobody reads.
 *
 * ⚠️ What this still cannot serialise: two adds for a type with NO row at all. `FOR UPDATE` locks
 * NOTHING when it matches nothing (same trap as `app-listing-review.service.ts`), so both insert and
 * the type ends up with two rows — enforced deterministically by `readBlocklistRow` and reported to
 * Axiom, but with one row's entries inert. `UsernameExact` is a tab with no row in production, so
 * the window is the initial seeding of a new tab, which is when two people are most likely to both
 * be in it.
 *
 * Two closes, neither taken here: a unique index on `Blocklist.type` (a migration, and the honest
 * one), or `pg_advisory_xact_lock` on the type as the transaction's first statement (no migration,
 * but it introduces a blocking primitive with no `lock_timeout` into both apps for a window this
 * narrow). Filed rather than folded in — do not read this as "unfixable without a migration".
 */
function readRowForWrite(trx: Transaction<DB>, type: string, id?: number) {
  const scoped = trx.selectFrom('Blocklist').select(['id', 'data']).where('type', '=', type);
  return (id === undefined ? scoped : scoped.where('id', '=', id))
    .orderBy('id', 'asc')
    .forUpdate()
    .executeTakeFirst();
}
