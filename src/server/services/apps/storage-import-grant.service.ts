// The per-source consent ledger for cross-app storage imports (`storage.imports` in a manifest).
//
// A consumer app reaches the viewer's data in a SOURCE app only while the viewer holds a grant
// for that (viewer, consumer, source) triple. Two records make that grant:
//   - `apps:storage:import` in the viewer's `app_user_scope_grants` row for the consumer — the
//     ordinary consent ledger, so the scope is withheld from block tokens, prompted for and
//     revoked exactly like `apps:storage:publish`;
//   - one row here per SOURCE app that consent covered, written by the prompted consent only
//     (`blocks.grantScopes`) and deleted by the viewer's per-source revoke.
// The mint signs the scope only while every declared source the consumer can reach has a row
// (`isImportScopeCovered`), so a later version that adds a source is prompted again; the storage
// route reads the row on every import call (`hasStorageImportGrant`, primary), so a per-source
// revoke takes effect on the next request, not the next mint.
//
// RAW SQL ONLY: the table is no-type in the Prisma schema and its migration is applied by hand,
// so a database without it reads as "nobody granted anything" (fail-closed) and a grant write
// there is refused with `STORAGE_IMPORT_UNAVAILABLE_MESSAGE`.
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  APP_STORAGE_ENABLED_FEATURES,
  APP_STORAGE_IMPORT_SCOPE,
  parseManifestStorage,
  type AppStorageFeature,
  type AppStorageImportAccess,
} from '~/shared/constants/block-storage.constants';

export const STORAGE_IMPORT_UNAVAILABLE_MESSAGE =
  'Sharing data between apps is not available yet. Try again later.';

/** `undefined_table`, as the driver or Prisma's raw-query error reports it. */
export function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: unknown };
  if (e.code === '42P01') return true;
  if (e.meta && typeof e.meta === 'object') {
    const meta = e.meta as { code?: unknown; message?: unknown };
    if (meta.code === '42P01') return true;
  }
  return false;
}

let missingTableLogged = false;
function noteMissingTable(site: string): void {
  if (missingTableLogged) return;
  missingTableLogged = true;
  logToAxiom(
    {
      name: 'app-blocks-storage-import-grants-missing',
      type: 'error',
      message:
        'app_storage_import_grants is missing from this database: apply migration 20261218120000_app_storage_import_grants. Every storage import is refused until it lands.',
      site,
    },
    'app-blocks'
  ).catch(() => undefined);
}

type RawClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** The source app ids the viewer has granted the consumer, or an empty set (fail-closed). */
export async function listStorageImportGrantSources(opts: {
  userId: number;
  consumerAppBlockId: string;
  db?: 'read' | 'write';
}): Promise<Set<string>> {
  const client = (opts.db === 'read' ? dbRead : dbWrite) as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      SELECT "source_app_block_id" AS "sourceAppBlockId"
      FROM "app_storage_import_grants"
      WHERE "user_id" = ${opts.userId} AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
    `) as Array<{ sourceAppBlockId: string }>;
    return new Set(rows.map((r) => r.sourceAppBlockId));
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    noteMissingTable('list');
    return new Set();
  }
}

/** Whether the viewer has granted the consumer their data in the source. Reads the primary. */
export async function hasStorageImportGrant(opts: {
  userId: number;
  consumerAppBlockId: string;
  sourceAppBlockId: string;
}): Promise<boolean> {
  const client = dbWrite as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      SELECT 1 AS "one"
      FROM "app_storage_import_grants"
      WHERE "user_id" = ${opts.userId}
        AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
        AND "source_app_block_id" = ${opts.sourceAppBlockId}
      LIMIT 1
    `) as unknown[];
    return rows.length > 0;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    noteMissingTable('has');
    return false;
  }
}

/** Record (or refresh) one grant per source. PROMPTED CONSENT ONLY: `blocks.grantScopes`. */
export async function recordStorageImportGrants(opts: {
  userId: number;
  consumerAppBlockId: string;
  sourceAppBlockIds: readonly string[];
}): Promise<void> {
  const sources = [...new Set(opts.sourceAppBlockIds)].filter(
    (id) => id !== opts.consumerAppBlockId
  );
  if (sources.length === 0) return;
  const client = dbWrite as unknown as RawClient;
  try {
    await client.$queryRaw`
      INSERT INTO "app_storage_import_grants"
        ("user_id", "consumer_app_block_id", "source_app_block_id")
      SELECT ${opts.userId}, ${opts.consumerAppBlockId}, s
      FROM unnest(${sources}::text[]) AS s
      ON CONFLICT ("user_id", "consumer_app_block_id", "source_app_block_id")
      DO UPDATE SET "granted_at" = CURRENT_TIMESTAMP
      RETURNING 1
    `;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    noteMissingTable('record');
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: STORAGE_IMPORT_UNAVAILABLE_MESSAGE,
    });
  }
}

/** Withdraw one source's grant. Returns whether a grant existed. */
export async function revokeStorageImportGrant(opts: {
  userId: number;
  consumerAppBlockId: string;
  sourceAppBlockId: string;
}): Promise<boolean> {
  const client = dbWrite as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      DELETE FROM "app_storage_import_grants"
      WHERE "user_id" = ${opts.userId}
        AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
        AND "source_app_block_id" = ${opts.sourceAppBlockId}
      RETURNING 1
    `) as unknown[];
    return rows.length > 0;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    noteMissingTable('revoke');
    return false;
  }
}

// ---------------------------------------------------------------------------
// The consumer's declared imports, resolved to source apps
// ---------------------------------------------------------------------------

const ALL_FEATURES = Object.fromEntries(
  Object.keys(APP_STORAGE_ENABLED_FEATURES).map((f) => [f, true])
) as Record<AppStorageFeature, boolean>;

export type ResolvedStorageImport = {
  /** The source app's blockId, as the manifest names it. */
  from: string;
  collections: string[];
  access: AppStorageImportAccess;
  /** The approved source app, or null when no approved app holds that blockId. */
  source: { appBlockId: string; name: string } | null;
};

/**
 * Every import a consumer manifest declares, each resolved to the APPROVED app that holds its
 * blockId (null when none does). A manifest whose storage does not parse declares none.
 */
export async function resolveDeclaredImports(manifest: unknown): Promise<ResolvedStorageImport[]> {
  const parsed = parseManifestStorage(manifest, ALL_FEATURES);
  if (parsed.errors.length > 0 || parsed.imports.size === 0) return [];
  const froms = [...parsed.imports.keys()];
  const rows = (await dbRead.appBlock.findMany({
    where: { blockId: { in: froms }, status: 'approved' },
    select: { id: true, blockId: true, manifest: true },
  })) as Array<{ id: string; blockId: string; manifest: unknown }>;
  const byBlockId = new Map(rows.map((r) => [r.blockId, r]));
  return froms.map((from) => {
    const decl = parsed.imports.get(from)!;
    const row = byBlockId.get(from);
    const name = (row?.manifest as { name?: unknown } | null)?.name;
    return {
      from,
      collections: [...decl.collections],
      access: decl.access,
      source: row ? { appBlockId: row.id, name: typeof name === 'string' ? name : from } : null,
    };
  });
}

/**
 * Whether the viewer's per-source grants cover every source the consumer can reach today (every
 * declared import whose blockId an approved app holds). The mint signs `apps:storage:import` only
 * when this holds, so a source added by a later version is prompted for. A declared source no
 * approved app holds needs no grant: nothing can be reached through it, and no grant could be
 * written for it.
 */
export async function isImportScopeCovered(opts: {
  userId: number;
  consumerAppBlockId: string;
  manifest: unknown;
}): Promise<boolean> {
  const imports = await resolveDeclaredImports(opts.manifest);
  const needed = imports.flatMap((i) => (i.source ? [i.source.appBlockId] : []));
  if (needed.length === 0) return true;
  const granted = await listStorageImportGrantSources({
    userId: opts.userId,
    consumerAppBlockId: opts.consumerAppBlockId,
    db: 'write',
  });
  return needed.every((id) => granted.has(id));
}

/**
 * For the mints: whether the viewer's per-source grants cover the consumer's imports, read only
 * when the token would carry `apps:storage:import` at all (`null` otherwise: nothing to check).
 */
export async function importScopeCoverage(
  userId: number,
  block: { id: string; manifest: unknown },
  requestedScopes: readonly string[]
): Promise<boolean | null> {
  if (!requestedScopes.includes(APP_STORAGE_IMPORT_SCOPE)) return null;
  return isImportScopeCovered({ userId, consumerAppBlockId: block.id, manifest: block.manifest });
}

/**
 * Moves `apps:storage:import` from `signable` to `missing` when the per-source grants do not
 * cover the consumer's imports (`covered === false`), so the host prompts for the sources the
 * viewer has not granted. The scope-ledger grant alone never signs it: an install records the
 * scope without a prompt naming any source.
 */
export function withholdUncoveredImportScope(
  partition: { signable: string[]; missing: string[] },
  covered: boolean | null
): { signable: string[]; missing: string[] } {
  if (covered !== false || !partition.signable.includes(APP_STORAGE_IMPORT_SCOPE)) return partition;
  return {
    signable: partition.signable.filter((s) => s !== APP_STORAGE_IMPORT_SCOPE),
    missing: [...partition.missing, APP_STORAGE_IMPORT_SCOPE],
  };
}
