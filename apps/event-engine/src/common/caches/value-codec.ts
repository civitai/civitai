/**
 * The ONE place that decides how a cached entity field is read back out of a
 * Redis hash.
 *
 * A Redis hash stores strings and nothing else, so every field of every cache
 * built by `createCache` is serialised on write and de-serialised on read. The
 * read used to GUESS the original type back from the text:
 *
 *     item[key] = isNaN(Number(value)) ? value : Number(value);
 *
 * That guess is lossy, and it is lossy for real, legal data:
 *
 *   - `'0222'`       -> `222`      a username's leading zeros are DESTROYED, and
 *                                  the name that comes out matches no account
 *   - `'2428023993'` -> `2428023993`  an all-digit username becomes a JSON
 *                                  number, so `/api/v1/images` emitted
 *                                  `"username":2428023993` unquoted and every
 *                                  typed client failed to decode the 200
 *   - `''`           -> `0`        because `Number('') === 0`
 *   - `'false'`      -> `'false'`  a truthy string, for a stored `false`
 *   - `'null'`       -> `'null'`   likewise truthy, and `deletedAt` is read as
 *                                  `!!value` by several consumers
 *
 * See civitai#4768 / civitai/cli#513. A Civitai username may be entirely digits
 * — `usernameSchema` is `/^[A-Za-z0-9_]*$/` — so this is legal data, not bad
 * data, and the endpoint's legacy Prisma branch (which does not go through this
 * cache) returned the same names correctly quoted the whole time.
 *
 * 🔴 THE FIX DELIBERATELY DOES NOT CHANGE THE STORED FORMAT. The bytes in Redis
 * are already correct — `'0222'` is stored as `0222`; only the read destroyed
 * it. Re-encoding (per-field JSON, say) would be tidier, but it cannot be rolled
 * out without a window in which processes running the OLD code read entries
 * written by the NEW code and render every string with literal quotes, and it
 * would only start helping once each entry had been rewritten (up to its TTL).
 * Declaring the field types instead is correct for entries ALREADY in Redis, on
 * the first read, with no migration, no cold cache and no version skew.
 *
 * What a declaration cannot repair is a field whose stored text is genuinely
 * ambiguous for its own declared type — `'null'` for a non-nullable string is
 * indistinguishable from a user literally named `null`. Those are called out at
 * the declaration sites.
 */

/**
 * How one cached field is to be read back.
 *
 * A trailing `?` marks the field nullable, which is what makes the stored text
 * `'null'` decode to `null` instead of to the truthy four-character string. It
 * is opt-in per field precisely because `'null'` is a legal username.
 */
export type CacheFieldType =
  | 'string'
  | 'string?'
  | 'number'
  | 'number?'
  | 'boolean'
  | 'boolean?'
  | 'date'
  | 'date?'
  | 'json'
  | 'json?';

/**
 * The declared type of every field a cache stores.
 *
 * Non-`Partial` on purpose: this is a compiler-enforced ledger, so adding a
 * column to a cache's `SELECT` (and to its `T`) fails to typecheck until the
 * field is declared here. Without that, a new field silently falls back to the
 * type guess this module exists to remove.
 */
export type CacheFieldTypes<T> = Record<Extract<keyof T, string>, CacheFieldType>;

/**
 * Hash fields that carry cache bookkeeping rather than entity data, and so must
 * never be decoded into the returned item.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['cachedAt', 'notFound', 'debounce']);

/**
 * De-serialise a Redis hash into an entity, using the cache's declared field
 * types. Both read paths in `createCache` — the ordinary one and the
 * lock-contention retry — go through here, so they cannot drift apart.
 */
export function decodeCacheFields<T>(
  hash: Record<string, string>,
  fieldTypes: CacheFieldTypes<T>
): Record<string, unknown> {
  const item: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(hash)) {
    if (RESERVED_FIELDS.has(key)) continue;

    const declared = (fieldTypes as Record<string, CacheFieldType | undefined>)[key];
    item[key] = declared ? decodeDeclared(value, declared) : decodeUndeclared(value);
  }

  return item;
}

function decodeDeclared(value: string, declared: CacheFieldType): unknown {
  const nullable = declared.endsWith('?');
  const base = nullable ? declared.slice(0, -1) : declared;

  // `String(null)`/`String(undefined)` are what the writer stored for an absent
  // value; both mean "no value" for a field declared nullable.
  if (nullable && (value === 'null' || value === 'undefined')) return null;

  switch (base) {
    case 'string':
      return value;
    case 'number': {
      const asNumber = Number(value);
      return Number.isNaN(asNumber) ? value : asNumber;
    }
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'date': {
      const asDate = new Date(value);
      return Number.isNaN(asDate.getTime()) ? value : asDate;
    }
    case 'json':
    default:
      return parseJson(value);
  }
}

/**
 * Fallback for a hash field with no declaration — a stale field left behind by a
 * removed column, or a bookkeeping key added by a future writer.
 *
 * This is the old guess with ONE repair, which is pure gain and cannot be wrong:
 * a number is recovered only when the text is the CANONICAL rendering of that
 * number, i.e. `String(Number(text)) === text`. `String(222)` can never produce
 * the text `'0222'`, so `'0222'` was never a number and must not be read back as
 * one. The same reasoning rescues `''` (`String(0)` is `'0'`, not `''`) and
 * `'1e5'`.
 */
function decodeUndeclared(value: string): unknown {
  if (value.startsWith('[') || value.startsWith('{')) {
    const parsed = parseJson(value);
    if (parsed !== value) return parsed;
  }

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && String(asNumber) === value) return asNumber;
  return value;
}

/** JSON.parse that returns the raw text rather than throwing a whole read away. */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
