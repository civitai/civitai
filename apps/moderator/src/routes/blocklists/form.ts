/**
 * Parsing of the blocklist form's own fields.
 *
 * Its own module rather than living in `+page.server.ts`, because that file imports the service,
 * which imports the database client, which throws on a missing `DATABASE_URL` at import time — so
 * nothing in it can be unit-tested without standing up an environment.
 */

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
