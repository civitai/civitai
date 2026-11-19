// Which apps are DELETED, for what their stored data may still do. Read by the storage access
// path (`resolveImportAccess`) and the import consent surfaces (`resolveDeclaredImports`), both
// through `importSourceStanding`, the ONE statement of "may this source app's data be reached".
//
// A deleted app is the deleted-app reaper's own definition (`jobs/reap-deleted-app-storage.ts`),
// without its waiting period: `app_blocks.storage_deleted_at` is set, the block is not approved,
// and nothing has written the block since (`updated_at` not after the deletion). Raw SQL only:
// the columns are hand-applied (migration `20261218120000_app_block_storage_deleted_at`) and
// absent from the Prisma client. Before they exist no app reads as deleted.
//
// While the record core is switched on (`APP_RECORD_CORE_ENABLED`), the reaper keeps the records
// users own in a deleted app, and:
//   - the owner reads, exports and deletes them through their own account surfaces (the
//     `appStorage` router), which never asked for the app's status;
//   - another app the user ALREADY granted keeps READ access to them through its import, so an
//     overlay built on them keeps working;
//   - no new grant names a deleted app: the consent surfaces never offer it, and an import with
//     no grant for it is refused, never prompted.
// Switched off, a deleted app is just an app that is not approved, as before.
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import type { AppRecordConfig } from '~/server/services/apps/app-record';
import { appRecordConfig } from '~/server/services/apps/app-record';

type RawClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** Postgres `undefined_column`, as Prisma raises it from a raw query (P2010, `meta.code`). */
function isUndefinedColumn(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  return e?.code === '42703' || e?.meta?.code === '42703';
}

/** The ids among `ids` whose app is deleted (see the module header). Reads the primary. */
export async function deletedAppBlockIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const client = dbWrite as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      SELECT b.id FROM app_blocks b
      WHERE b.id = ANY(${[...ids]}::text[])
        AND b.storage_deleted_at IS NOT NULL
        AND b.status <> 'approved'
        AND b.updated_at <= b.storage_deleted_at
    `) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    if (isUndefinedColumn(err)) return new Set();
    throw err;
  }
}

/**
 * How another app may reach a source app's stored data:
 *   - `live`: the source is approved — what its import declares, as always;
 *   - `deleted`: the source is deleted and the record core is on — READ only, and only through a
 *     grant the viewer gave before (never a new one);
 *   - `unavailable`: anything else (not approved, or deleted with the core off).
 * The ONE rule; `resolveImportAccess` and `resolveDeclaredImports` both read it.
 */
export type ImportSourceStanding = 'live' | 'deleted' | 'unavailable';

export async function importSourceStandings(
  sources: ReadonlyArray<{ id: string; status: string }>,
  recordCore: AppRecordConfig | null = appRecordConfig(env)
): Promise<Map<string, ImportSourceStanding>> {
  const out = new Map<string, ImportSourceStanding>();
  const notApproved: string[] = [];
  for (const s of sources) {
    if (s.status === 'approved') out.set(s.id, 'live');
    else {
      out.set(s.id, 'unavailable');
      notApproved.push(s.id);
    }
  }
  // Switched off, nothing else is read: a source that is not approved is unavailable, as before.
  if (recordCore === null || notApproved.length === 0) return out;
  for (const id of await deletedAppBlockIds(notApproved)) out.set(id, 'deleted');
  return out;
}

/** {@link importSourceStandings} for one source. */
export async function importSourceStanding(
  source: { id: string; status: string },
  recordCore?: AppRecordConfig | null
): Promise<ImportSourceStanding> {
  const standings =
    recordCore === undefined
      ? await importSourceStandings([source])
      : await importSourceStandings([source], recordCore);
  return standings.get(source.id) ?? 'unavailable';
}
