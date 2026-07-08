import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { dbRead, dbWrite } from './db';
import { getRedis } from './redis';

// Blocklist CRUD for the moderator page. The spoke owns the mutation, writing BOTH the `Blocklist` table
// and the shared Redis cache under the SAME key/shape/TTL the main app reads (its link/message/email
// validators + the sync-email-blocklist cron) — so main-app readers see edits with no callback.

export type BlocklistDTO = { id?: number; type: string; data: string[] };

const MONTH_TTL = 60 * 60 * 24 * 30; // matches the main app's CacheTTL.month

const blocklistKey = (type: string) =>
  `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}` as RedisKeyTemplateCache;

async function setCache(data: BlocklistDTO) {
  await getRedis().set(blocklistKey(data.type), JSON.stringify(data), { EX: MONTH_TTL });
}

export async function getBlocklistDTO({ type }: { type: string }): Promise<BlocklistDTO> {
  const cached = await getRedis().get(blocklistKey(type));
  if (cached) return JSON.parse(cached) as BlocklistDTO;

  const row = await dbRead
    .selectFrom('Blocklist')
    .select(['id', 'type', 'data'])
    .where('type', '=', type)
    .limit(1)
    .executeTakeFirst();
  const result: BlocklistDTO = row ?? { type, data: [] };

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

  await setCache(result);
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
  await setCache(updated);
}
