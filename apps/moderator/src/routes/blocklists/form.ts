/**
 * Parsing of the blocklist form's own fields.
 *
 * Its own module rather than living in `+page.server.ts`, because that file imports the service,
 * which imports the database client, which throws on a missing `DATABASE_URL` at import time — so
 * nothing in it can be unit-tested without standing up an environment.
 */

import { isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';

/**
 * `undefined` for an absent field, `null` for anything that is not a usable row id, the number
 * otherwise. The three are distinct and none may collapse into another: `undefined` means "no row
 * named, act on the type", a number means "act on that row", `null` means "refuse".
 *
 * 🔴 Not `raw ? Number(raw) : undefined`. `id` is a hidden form field, so the client picks it.
 * `Number('abc')` is `NaN`, which is neither falsy as a form value nor `undefined`, so it reached
 * `where('id', '=', NaN)` — and `pg` serialises that as the text `NaN`, which Postgres rejects with
 * `invalid input syntax for type integer`. That escapes the `BlocklistRowMismatchError` catch as a
 * 500 rather than the `fail(400)` every other malformed field here produces. `1e999` (`Infinity`)
 * and `1.5` arrive by the same door.
 */
export function parseRowId(raw: FormDataEntryValue | null): number | undefined | null {
  if (raw === null || String(raw).length === 0) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Entries that would save but never take effect. The profanity filter checks its benign words
 * against the single `\w+` run around a match (`extractFullWord` in the main app's
 * `profanity-simple`), so an entry with a space or punctuation in it can never equal one.
 */
export function inertEntries(type: string, items: string[]): string[] {
  if (type === 'ProfanityWord') return items.filter((item) => !isUsableBlockedEntry(item));
  if (type === 'ProfanityBenignWord') return items.filter((item) => /[\s\W]/.test(item));
  // The main app's POI matching keeps only ASCII word characters, spaces and a few separators of
  // a query (`poiCheckOptions` in src/utils/metadata/audit.ts), and drops a name it strips to
  // nothing.
  if (type === 'SemanticSearchPoiRefuse')
    return items.filter((item) => !item.replace(/[^\w\s|:[\],]/g, '').trim());
  return [];
}

export function inertEntriesError(type: string, inert: string[]): string {
  const list = inert.map((i) => `"${i}"`).join(', ');
  if (type === 'ProfanityWord')
    return `Each entry needs at least 4 letters (3 with | at its start or end), and only letters, spaces, hyphens, apostrophes or | at its ends: ${list}.`;
  if (type === 'SemanticSearchPoiRefuse')
    return `Search matching only sees Latin letters, digits and spaces in a name, so these could never match: ${list}.`;
  return `Not a single word, so the filter can never match it: ${list}. Enter one word per entry, without spaces or punctuation.`;
}
