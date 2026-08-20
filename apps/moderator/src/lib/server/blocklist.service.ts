import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { dbRead, dbWrite } from './db';
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
  const rows = await dbRead
    .selectFrom('Blocklist')
    .select(['id', 'type', 'data'])
    .where('type', '=', type)
    .orderBy('id', 'asc')
    .execute();

  if (rows.length > 1) {
    console.error(
      `[blocklist] ${rows.length} rows for type ${type}; using id ${rows[0].id}, ignoring ${rows
        .slice(1)
        .map((row) => row.id)
        .join(', ')} — entries on the ignored rows are NOT enforced`
    );
  }

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
