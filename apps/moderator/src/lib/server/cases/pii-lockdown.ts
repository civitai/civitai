import { sql, type Kysely } from 'kysely';
import { CASE_CLOSED_TABLES } from './cases-tables';

/** The read-only login agents use on the moderator database. */
export const CASES_RO_ROLE = 'internal_tools_ro';
const DEFINITION_TABLES = ['process_definition', 'process_definition_version'] as const;

export type PiiLockdown = 'ok' | 'open' | 'no-role';

/**
 * Whether the read-only role is shut out of the case tables now. This is the `ro_ok` column of the read-back
 * in `cases/schema.sql`, run by the app, because a grant made after the apply (`GRANT SELECT ON ALL
 * TABLES`, a role membership) reopens them and nothing else would notice.
 *
 * `open`: it can read a closed table, or write any case table, directly, through PUBLIC, or through a role it
 * can SET ROLE to; or it can't read the definitions it is meant to. `no-role`: the role doesn't
 * exist, so there is nothing to be open to.
 */
export async function readPiiLockdown(db: Kysely<unknown>): Promise<PiiLockdown> {
  const { rows } = await sql<{ ok: boolean | null }>`
    SELECT bool_and(
      CASE WHEN t = ANY(${[...DEFINITION_TABLES]}::text[])
        THEN COALESCE(has_table_privilege(r.oid, to_regclass(t), 'SELECT'), false)
        ELSE COALESCE(NOT has_any_column_privilege(r.oid, to_regclass(t), 'SELECT'), false)
          AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid <> r.oid AND pg_has_role(r.oid, g.oid, 'MEMBER')
            AND has_any_column_privilege(g.oid, to_regclass(t), 'SELECT'))
      END
      -- No write, by the role or any role it can SET ROLE to. Column-level INSERT/UPDATE grants count:
      -- has_table_privilege alone misses them. A missing table (NULL) counts as not locked down.
      AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE (g.oid = r.oid OR pg_has_role(r.oid, g.oid, 'MEMBER'))
        AND (COALESCE(has_any_column_privilege(g.oid, to_regclass(t), 'INSERT, UPDATE, REFERENCES'), true)
          OR COALESCE(has_table_privilege(g.oid, to_regclass(t), 'DELETE, TRUNCATE, TRIGGER'), true)))
    ) AS ok
    FROM pg_roles r, unnest(${[...DEFINITION_TABLES, ...CASE_CLOSED_TABLES]}::text[]) t
    WHERE r.rolname = ${CASES_RO_ROLE}
  `.execute(db);
  const ok = rows[0]?.ok;
  return ok === null || ok === undefined ? 'no-role' : ok ? 'ok' : 'open';
}
