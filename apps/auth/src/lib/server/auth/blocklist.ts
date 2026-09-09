import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '../redis';
import { db } from '../db/db';
import { logAxiomError } from '../axiom';

// Blocked email domains — mirrors the main app's getBlockedEmailDomains (blocklist.service.ts).
// The main app keeps `${REDIS_KEYS.SYSTEM.BLOCKLIST}:EmailDomain` warm (a JSON {type, data[]},
// refreshed on read). We read that shared cache first, then fall back to the Blocklist table on a
// cold cache (and best-effort repopulate). Same redis + same DB = same list.
/**
 * Derived from the type, never passed alongside it. A `(type, key)` pair that disagrees would DB-read
 * one type's rows and cache them under another type's key — the key the main app and the moderator
 * spoke also read, so one copy-pasted line poisons the shared cache for three apps for a whole TTL.
 * Both other apps derive it the same way (`blocklistKey`, `getBlocklistKey`).
 */
const blocklistKey = (type: string) => `${REDIS_KEYS.SYSTEM.BLOCKLIST}:${type}`;

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
export function isBlockedExactDomain(entries: string[], domain: string): boolean {
  return !!domain && entries.some((entry) => normalizeDomain(entry) === domain);
}

/**
 * `*.evil.example` and `.evil.example` are how a moderator writes "and its subdomains" by hand, and
 * unstripped both are entries that match no address at all — silently, since a suffix entry's only
 * feedback is accounts continuing to arrive.
 */
const SUFFIX_ENTRY_PREFIX = /^(?:\*)?\.+/;

/**
 * The domain itself, or anything under it. `endsWith('.' + entry)` and not `endsWith(entry)`: the
 * latter matches `notevil.example` against an entry of `evil.example`, a different registrable
 * domain owned by someone else.
 *
 * Twin of `matchesBlockedSuffix` in the main app's `src/server/services/blocklist.service.ts`. The
 * two are one rule in two separately-released apps: keep the case table in `__tests__/blocklist.test.ts`
 * identical to the one beside that function, INCLUDING the leading-whitespace wildcard entry, which
 * is the cell where they have already disagreed once.
 */
export function isBlockedSuffix(entries: string[], domain: string): boolean {
  if (!domain) return false;
  return entries.some((raw) => {
    // 🔴 NORMALIZE, THEN STRIP, THEN NORMALIZE AGAIN — the order is the whole content of this line.
    // `SUFFIX_ENTRY_PREFIX` is `^`-anchored, so stripping the RAW string leaves ` *.farm.test`
    // untouched and the entry then matches no address at all, silently. The main app trims first,
    // so that entry is enforced there and inert here: a divergence, in the direction that admits
    // a signup, on the path this list exists for.
    const entry = normalizeDomain(normalizeDomain(raw).replace(SUFFIX_ENTRY_PREFIX, ''));
    if (!entry) return false;
    // 🔴 A SINGLE LABEL IS REFUSED. Nothing validates what a moderator types, and `com` is one
    // keystroke from `com.example` — it would refuse every address under the whole TLD. The exact
    // list cannot do that, so the blast radius is new to this list.
    if (!entry.includes('.')) return false;
    return domain === entry || domain.endsWith(`.${entry}`);
  });
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

async function readBlocklist(type: string): Promise<string[]> {
  const key = blocklistKey(type);
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await (redis as unknown as StringGet).get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as { data?: string[] };
        return parsed.data ?? [];
      }
    } catch (error) {
      // Fall through to the DB — but say so. See the DB catch below for why silence is the hazard.
      void logAxiomError(error, { event: 'blocklist-cache-read-failed', blocklistType: type });
    }
  }

  try {
    const row = await db
      .selectFrom('Blocklist')
      .select('data')
      .where('type', '=', type)
      // 🔴 The main app's `readBlocklistRow` pins `orderBy: { id: 'asc' }`. Without the same
      // ordering here, a type with two rows lets this app enforce a different list than the main
      // app does — on the signup path. A unique index on `Blocklist.type` makes that
      // unrepresentable; this makes the two agree until it is applied, and after.
      .orderBy('id', 'asc')
      .executeTakeFirst();
    const data = row?.data ?? [];
    if (redis) {
      await (redis as unknown as StringSet)
        .set(key, JSON.stringify({ type, data }), { EX: TTL_SECONDS })
        .catch(() => {});
    }
    return data;
  } catch (error) {
    // 🔴 DEGRADE OPEN, but never silently. Returning `[]` admits every blocked signup, and
    // `blockedEmailDomainSignupsTotal` only counts BLOCKS — so with no log the sole tell is a
    // counter quietly reaching zero, and a moderator who just added an entry sees it on the page
    // with no way to know it is not being enforced. The main app logs the same condition as
    // `email-blocklist-lookup-failed`.
    void logAxiomError(error, { event: 'blocklist-lookup-failed', blocklistType: type });
    return [];
  }
}

export async function getBlockedEmailDomains(): Promise<string[]> {
  return readBlocklist('EmailDomain');
}

/**
 * Entries that block the domain AND its subdomains. Opt-in per entry; twin of
 * `getBlockedEmailDomainSuffixes` in the main app's `src/server/services/blocklist.service.ts`.
 */
export async function getBlockedEmailDomainSuffixes(): Promise<string[]> {
  return readBlocklist('EmailDomainSuffix');
}

/**
 * Both lists, in the order that keeps the second lookup off the path an ordinary signup takes. Used
 * by both hub call sites so one of them cannot quietly stop consulting the suffix list.
 *
 * Callers must still exempt users who ALREADY have this address — a list entry added later must not
 * lock out an account that predates it.
 */
export async function isBlockedEmailDomain(domain: string): Promise<boolean> {
  if (!domain) return false;
  if (isBlockedExactDomain(await getBlockedEmailDomains(), domain)) return true;
  return isBlockedSuffix(await getBlockedEmailDomainSuffixes(), domain);
}
