import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { dbWrite } from './db';
import { logToAxiom } from './axiom';
import { getRedis } from './redis';

// Writes BOTH the Blocklist table AND the shared Redis cache (same key/shape/TTL the main app reads), so
// main-app validators see edits with no callback.

export type BlocklistDTO = { id?: number; type: string; data: string[] };

const MONTH_TTL = 60 * 60 * 24 * 30; // matches the main app's CacheTTL.month

const blocklistKey = (type: string) =>
  `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;

async function setCache(data: BlocklistDTO) {
  await getRedis().set(blocklistKey(data.type), JSON.stringify(data), { EX: MONTH_TTL });
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
  // `dbWrite`, not `dbRead`, and this is load-bearing: both writers below re-read through here
  // and then cache the result for a MONTH. Off the replica, a write-then-read races replication
  // and would pin the PRE-EDIT row into a key the main app also reads — a moderator's change
  // silently undone for 30 days, which is the failure this function exists to prevent. The
  // writers already read writer-side for the same reason.
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
        app: 'moderator',
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

export async function upsertBlocklist({
  id,
  type,
  blocklist,
}: {
  id?: number;
  type: string;
  blocklist: string[];
}): Promise<void> {
  const items = blocklist.map((item) => item.toLowerCase()).filter((x) => x.length > 0);

  let result: BlocklistDTO;
  if (!id) {
    result = await dbWrite
      .insertInto('Blocklist')
      .values({ type, data: items, updatedAt: new Date() })
      .returning(['id', 'type', 'data'])
      .executeTakeFirstOrThrow();
  } else {
    const existing = await dbWrite
      .selectFrom('Blocklist')
      .select('data')
      .where('id', '=', id)
      .executeTakeFirst();
    const merged = [...new Set([...(existing?.data ?? []), ...items])];
    result = await dbWrite
      .updateTable('Blocklist')
      .set({ data: merged, updatedAt: new Date() })
      .where('id', '=', id)
      .returning(['id', 'type', 'data'])
      .executeTakeFirstOrThrow();
  }

  // Cache the row that WINS the read, not the one just written. Caching `result` is what let an
  // edit to a duplicate row silently promote it to the live answer for the whole month TTL —
  // and this key is shared with the main app, so it would poison that read too.
  await setCache(await readBlocklistRow(result.type));
}

export async function removeBlocklistItems({
  id,
  items,
}: {
  id: number;
  items: string[];
}): Promise<void> {
  const lower = items.map((x) => x.toLowerCase());
  const row = await dbWrite
    .selectFrom('Blocklist')
    .select('data')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return;

  const filtered = row.data.filter((item) => !lower.includes(item));
  const updated = await dbWrite
    .updateTable('Blocklist')
    .set({ data: filtered, updatedAt: new Date() })
    .where('id', '=', id)
    .returning(['id', 'type', 'data'])
    .executeTakeFirstOrThrow();
  await setCache(await readBlocklistRow(updated.type));
}
