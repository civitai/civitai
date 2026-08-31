import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '../redis';
import { db } from '../db/db';

// Blocked email domains — mirrors the main app's getBlockedEmailDomains (blocklist.service.ts).
// The main app keeps `${REDIS_KEYS.SYSTEM.BLOCKLIST}:EmailDomain` warm (a JSON {type, data[]},
// refreshed on read). We read that shared cache first, then fall back to the Blocklist table on a
// cold cache (and best-effort repopulate). Same redis + same DB = same list.
const BLOCKLIST_KEY = `${REDIS_KEYS.SYSTEM.BLOCKLIST}:EmailDomain`;

/**
 * A CEILING on staleness, not a cache lifetime. The moderator writers DELETE this key, so an edit
 * normally takes effect on the next read. What the delete cannot reach is the repopulate below: it
 * reads the row and then writes, so a read that happened before a write commits can land its
 * pre-write copy after that write's delete. Only another write to the same type clears it, and on
 * production three of the eight lists had gone 8, 46 and 676 days without one.
 *
 * Must match the main app and the moderator spoke, which populate this same key. A shorter value
 * anywhere is harmless; a longer one reinstates the window for whichever app wrote it.
 */
const TTL_SECONDS = 5 * 60;

type StringGet = { get(k: string): Promise<string | null | undefined> };
type StringSet = { set(k: string, v: string, o: { EX: number }): Promise<unknown> };

/** Trailing dot is the FQDN root and resolves identically, so it must not read as a new domain. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * The domain of an email address, normalized for comparison against the blocklist.
 *
 * `lastIndexOf`, not `split('@')[1]`: a quoted-local address ("a@b"@host) carries more than one
 * `@`, and taking the first segment yields a domain that matches no list entry — i.e. it ADMITS a
 * blocked address. Shared by both hub call sites so reverting one cannot silently diverge from the
 * other; the main app carries its own copy of the same rule in `blocklist.service.ts`.
 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : normalizeDomain(email.slice(at + 1));
}

/**
 * Both sides go through the SAME normalizer. Stripping the input but not the list entry would make
 * a hand-typed `provider.com.` enforced by the main app and silently inert here — the exact
 * divergence `emailDomain` was extracted to prevent. The row is hand-edited by moderators, which is
 * the premise the case-normalization rule rests on too.
 */
export function isBlockedDomain(entries: string[], domain: string): boolean {
  return !!domain && entries.some((entry) => normalizeDomain(entry) === domain);
}

/**
 * The address as it should be STORED and LOOKED UP.
 *
 * `userExistsByEmail` is both the returning-user exemption for the blocklist and the gate on the
 * `+`-alias block, and both key on the exact stored string. Without this a trailing dot is a free
 * second identity against both: one real mailbox, two `User` rows past a citext-unique column.
 */
export function normalizeEmailAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return email.trim().toLowerCase();
  return `${email.slice(0, at).trim()}@${normalizeDomain(email.slice(at + 1))}`;
}

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
