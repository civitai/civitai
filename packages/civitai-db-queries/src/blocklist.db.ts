import { type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Blocklist CRUD for the moderator page. The moderator spoke's `blocklist.service` wraps these, layering the
// shared Redis cache (main-app validators + the sync-email-blocklist cron read it under the same key) on top.
// Only the Postgres statements live here — the redis read/write stays with the caller. `Blocklist.data` is a
// Postgres `text[]`, so it is written as a plain JS array (no `toJson` — that column is not jsonb).

export type BlocklistRow = { id: number; type: string; data: string[] };

// The read shape: a found row, or an empty placeholder (no id) when the type has no blocklist yet.
export type BlocklistDTO = { id?: number; type: string; data: string[] };

// The single Blocklist row for a type, or an empty placeholder if none exists.
export async function getBlocklist(
  db: Kysely<DB>,
  { type }: { type: string }
): Promise<BlocklistDTO> {
  const row = await db
    .selectFrom('Blocklist')
    .select(['id', 'type', 'data'])
    .where('type', '=', type)
    .limit(1)
    .executeTakeFirst();

  return row ?? { type, data: [] };
}

// Insert a new blocklist (no id) or merge items into an existing one (union with the current data). Items are
// lowercased and empties dropped, matching the source. Returns the written row so the caller can refresh cache.
export async function upsertBlocklist(
  db: Kysely<DB>,
  {
    id,
    type,
    blocklist,
  }: {
    id?: number;
    type: string;
    blocklist: string[];
  }
): Promise<BlocklistRow> {
  const items = blocklist.map((item) => item.toLowerCase()).filter((x) => x.length > 0);

  if (!id) {
    return db
      .insertInto('Blocklist')
      .values({ type, data: items, updatedAt: new Date() })
      .returning(['id', 'type', 'data'])
      .executeTakeFirstOrThrow();
  }

  const existing = await db
    .selectFrom('Blocklist')
    .select('data')
    .where('id', '=', id)
    .executeTakeFirst();
  const merged = [...new Set([...(existing?.data ?? []), ...items])];

  return db
    .updateTable('Blocklist')
    .set({ data: merged, updatedAt: new Date() })
    .where('id', '=', id)
    .returning(['id', 'type', 'data'])
    .executeTakeFirstOrThrow();
}

// Remove the given items from a blocklist (case-insensitive). No-op if the row is gone. Returns the updated
// row so the caller can refresh cache.
export async function removeBlocklistItems(
  db: Kysely<DB>,
  {
    id,
    items,
  }: {
    id: number;
    items: string[];
  }
): Promise<BlocklistRow | undefined> {
  const lower = items.map((x) => x.toLowerCase());

  const row = await db
    .selectFrom('Blocklist')
    .select('data')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;

  const filtered = row.data.filter((item) => !lower.includes(item));

  return db
    .updateTable('Blocklist')
    .set({ data: filtered, updatedAt: new Date() })
    .where('id', '=', id)
    .returning(['id', 'type', 'data'])
    .executeTakeFirstOrThrow();
}
