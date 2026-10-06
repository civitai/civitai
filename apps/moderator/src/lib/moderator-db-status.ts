/**
 * Why a read of a hand-applied moderator-database table failed — discriminated, because each state has
 * a different remedy and an undifferentiated "could not load" sends an operator hunting an outage on a
 * database that is healthy.
 *
 * In `$lib`, not `$lib/server`: the notices that render these states are client code.
 */
export type ModeratorDbStatus = 'ok' | 'no-schema' | 'no-grant' | 'not-configured' | 'unreachable';

/**
 * Classify a failed query against the moderator database.
 *
 * `42P01` undefined_table: the hand-applied DDL has not been run here. `42501` insufficient_privilege:
 * it was run as a role other than the application's (the natural `psql -U postgres` shortcut). An
 * unset `MODERATOR_DATABASE_URL` throws before any query does.
 */
export function moderatorDbStatus(e: unknown): Exclude<ModeratorDbStatus, 'ok'> {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42P01') return 'no-schema';
  if (code === '42501') return 'no-grant';
  if (e instanceof Error && e.message.includes('DATABASE_URL')) return 'not-configured';
  return 'unreachable';
}

/**
 * The 503 text for a store that cannot be read, per cause — so every page reading the same tables
 * says the same thing about them.
 */
export function storeUnavailableMessage(
  status: Exclude<ModeratorDbStatus, 'ok'>,
  names: { tables: string; database: string; schemaFile: string }
): string {
  switch (status) {
    case 'no-schema':
      return `${names.tables} do not exist yet — apply ${names.schemaFile}.`;
    case 'no-grant':
      return `${names.tables} exist but this role cannot read them — re-run ${names.schemaFile} as the application role.`;
    case 'not-configured':
      return 'MODERATOR_DATABASE_URL is not configured for this environment.';
    case 'unreachable':
      return `Could not reach ${names.database}.`;
  }
}
