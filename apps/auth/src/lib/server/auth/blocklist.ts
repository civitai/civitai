import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '../redis';
import { db } from '../db/db';

// Blocked email domains — mirrors the main app's getBlockedEmailDomains (blocklist.service.ts).
// The main app keeps `${REDIS_KEYS.SYSTEM.BLOCKLIST}:EmailDomain` warm (a JSON {type, data[]} with a
// ~1-month TTL, refreshed on read). We read that shared cache first, then fall back to the
// Blocklist table on a cold cache (and best-effort repopulate). Same redis + same DB = same list.
const BLOCKLIST_KEY = `${REDIS_KEYS.SYSTEM.BLOCKLIST}:EmailDomain`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30d, matches the main app

type StringGet = { get(k: string): Promise<string | null | undefined> };
type StringSet = { set(k: string, v: string, o: { EX: number }): Promise<unknown> };

export async function getBlockedEmailDomains(): Promise<string[]> {
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await (redis as unknown as StringGet).get(BLOCKLIST_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { data?: string[] };
        return parsed.data ?? [];
      }
    } catch {
      // fall through to the DB
    }
  }

  try {
    const row = await db
      .selectFrom('Blocklist')
      .select('data')
      .where('type', '=', 'EmailDomain')
      .executeTakeFirst();
    const data = row?.data ?? [];
    if (redis) {
      await (redis as unknown as StringSet)
        .set(BLOCKLIST_KEY, JSON.stringify({ type: 'EmailDomain', data }), { EX: TTL_SECONDS })
        .catch(() => {});
    }
    return data;
  } catch {
    return []; // degrade open — a lookup failure must not block every login
  }
}
