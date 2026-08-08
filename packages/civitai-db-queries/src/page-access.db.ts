import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Which roles may reach which page, per app. A row's `roles` is authoritative — an empty array means
// nobody — while a missing row means the app has never been told about that page and should fall back to
// whatever its code declares. Roles are opaque strings; each app owns its own vocabulary.

export type PageAccessGrants = Record<string, string[]>;

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
