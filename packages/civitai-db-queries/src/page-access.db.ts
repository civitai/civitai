import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Which roles may reach which page, per app. A row's `roles` is authoritative — an empty array means
// nobody — while a missing row means the app has never been told about that page and should fall back to
// whatever its code declares. Roles are opaque strings here, but the vocabulary is the auth hub's: it
// mints them as `app:slug` in the `Role` table, and `listAppRoles` reads one app's slice of it.

export type PageAccessGrants = Record<string, string[]>;

/**
 * Every role the auth hub has defined for one app, as `app:slug`. The hub's `Role` table is the
 * catalogue: an app that keeps its own list cannot show a role someone created there.
 *
 * `app` goes into a `LIKE` pattern unescaped, so it must not contain `%` or `_`. Callers pass a literal
 * today and the hub slugifies prefixes to `[a-z0-9-]`, but that invariant lives in the hub, not here.
 */
export async function listAppRoles(db: Kysely<DB>, app: string): Promise<string[]> {
  const rows = await db
    .selectFrom('Role')
    .select('id')
    .where('id', 'like', `${app}:%`)
    .orderBy('id')
    .execute();
  return rows.map((r) => r.id);
}

export async function getPageAccessGrants(db: Kysely<DB>, app: string): Promise<PageAccessGrants> {
  const rows = await db
    .selectFrom('AppPageAccess')
    .select(['path', 'roles'])
    .where('app', '=', app)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.path, r.roles]));
}

// Pass `roles` as a plain array value — interpolating it through the `sql` tag would render a value list
// (`($1, $2)`), which is not a text[] and is a syntax error when the array is empty.
export async function setPageAccessRoles(
  db: Kysely<DB>,
  input: { app: string; userId: number; entries: { path: string; roles: string[] }[] }
): Promise<void> {
  if (!input.entries.length) return;
  const now = new Date();
  await db
    .insertInto('AppPageAccess')
    .values(
      input.entries.map((entry) => ({
        app: input.app,
        path: entry.path,
        roles: entry.roles,
        updatedById: input.userId,
        updatedAt: now,
      }))
    )
    .onConflict((oc) =>
      oc.columns(['app', 'path']).doUpdateSet((eb) => ({
        roles: eb.ref('excluded.roles'),
        updatedById: eb.ref('excluded.updatedById'),
        updatedAt: eb.ref('excluded.updatedAt'),
      }))
    )
    .execute();
}

/**
 * Insert rows only where none exists, leaving every stored row untouched — the write half of an app's
 * "seed a newly declared grant with its default" reconcile. `DO NOTHING`, not `DO UPDATE`: a row that is
 * already there is a decision someone made, including a row granting nobody, and re-running must never
 * overwrite it. Returns how many rows were actually created.
 */
export async function insertMissingPageAccess(
  db: Kysely<DB>,
  input: { app: string; userId: number | null; entries: { path: string; roles: string[] }[] }
): Promise<number> {
  if (!input.entries.length) return 0;
  const now = new Date();
  const result = await db
    .insertInto('AppPageAccess')
    .values(
      input.entries.map((entry) => ({
        app: input.app,
        path: entry.path,
        roles: entry.roles,
        updatedById: input.userId,
        updatedAt: now,
      }))
    )
    .onConflict((oc) => oc.columns(['app', 'path']).doNothing())
    .executeTakeFirst();
  return Number(result?.numInsertedOrUpdatedRows ?? 0);
}

export async function clearPageAccess(
  db: Kysely<DB>,
  input: { app: string; path: string }
): Promise<void> {
  await db
    .deleteFrom('AppPageAccess')
    .where('app', '=', input.app)
    .where('path', '=', input.path)
    .execute();
}
