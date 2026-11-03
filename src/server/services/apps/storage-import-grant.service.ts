// The per-source consent ledger for cross-app storage imports (`storage.imports`).
//
// A grant is TWO records: `apps:storage:import` in the viewer's ordinary scope grant for the
// consumer, and one row here per source holding the collections and access the prompt showed.
// The scope alone never signs: an install records it with no prompt naming any source. A row
// covers an import that names no other collection and asks no more access (`importGrantCovers`).
// The storage route reads the row on the primary on every call, so a revoke is immediate.
//
// RAW SQL ONLY: the migration is applied by hand, so a missing table (or one without its
// columns) reads as "nobody granted anything", and a grant write there is refused.
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isMissingColumnError } from '~/server/services/blocks/scope-grant.service';
import { ratingAllowedOnHost } from '~/server/utils/server-domain';
import {
  APP_STORAGE_ENABLED_FEATURES,
  APP_STORAGE_IMPORT_SCOPE,
  parseManifestStorage,
  type AppStorageFeature,
  type AppStorageImportAccess,
} from '~/shared/constants/block-storage.constants';

export const STORAGE_IMPORT_UNAVAILABLE_MESSAGE =
  'Sharing data between apps is not available yet. Try again later.';

/**
 * The ledger's hand-applied migration has not run (no table), or a table from its earlier draft
 * (no `collections` / `access`) is in place: both read as "nobody granted anything". The two
 * canonical predicates, composed; `app-access.service` is imported lazily, as
 * `app-listing.service` does, so the storage route does not load the listing services.
 */
async function isLedgerMissing(err: unknown): Promise<boolean> {
  if (isMissingColumnError(err)) return true;
  const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
  return isMissingTableError(err);
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
        'app_storage_import_grants is missing from this database, or lacks its collections/access columns: apply migration 20261218120000_app_storage_import_grants. Every storage import is refused until it lands.',
      site,
    },
    'app-blocks'
  ).catch(() => undefined);
}

type RawClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** What one grant row covers: the collections and access the consent prompt showed. */
export type StorageImportGrant = { collections: string[]; access: AppStorageImportAccess };

/**
 * Whether a grant covers a declared import: every collection it names was granted, and the
 * grant's access is at least the import's (`readwrite` covers `read`). The ONE statement of the
 * rule; the mint and the storage route both read it.
 */
export function importGrantCovers(
  grant: StorageImportGrant | null | undefined,
  declared: { collections: Iterable<string>; access: AppStorageImportAccess }
): boolean {
  if (!grant) return false;
  if (declared.access === 'readwrite' && grant.access !== 'readwrite') return false;
  const granted = new Set(grant.collections);
  for (const c of declared.collections) if (!granted.has(c)) return false;
  return true;
}

type GrantRow = { sourceAppBlockId: string; collections: string[]; access: string };
const toGrant = (r: GrantRow): StorageImportGrant => ({
  collections: [...r.collections],
  // The column's CHECK admits these two only.
  access: r.access === 'readwrite' ? 'readwrite' : 'read',
});

/** The viewer's grants for the consumer, by source app id, or an empty map (fail-closed). */
export async function listStorageImportGrants(opts: {
  userId: number;
  consumerAppBlockId: string;
  db?: 'read' | 'write';
}): Promise<Map<string, StorageImportGrant>> {
  const client = (opts.db === 'read' ? dbRead : dbWrite) as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      SELECT "source_app_block_id" AS "sourceAppBlockId", "collections", "access"
      FROM "app_storage_import_grants"
      WHERE "user_id" = ${opts.userId} AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
    `) as GrantRow[];
    return new Map(rows.map((r) => [r.sourceAppBlockId, toGrant(r)]));
  } catch (err) {
    if (!(await isLedgerMissing(err))) throw err;
    noteMissingTable('list');
    return new Map();
  }
}

/** The viewer's grant for (consumer, source), or null. Reads the primary. */
export async function getStorageImportGrant(opts: {
  userId: number;
  consumerAppBlockId: string;
  sourceAppBlockId: string;
}): Promise<StorageImportGrant | null> {
  const client = dbWrite as unknown as RawClient;
  try {
    const rows = (await client.$queryRaw`
      SELECT "source_app_block_id" AS "sourceAppBlockId", "collections", "access"
      FROM "app_storage_import_grants"
      WHERE "user_id" = ${opts.userId}
        AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
        AND "source_app_block_id" = ${opts.sourceAppBlockId}
      LIMIT 1
    `) as GrantRow[];
    return rows.length > 0 ? toGrant(rows[0]) : null;
  } catch (err) {
    if (!(await isLedgerMissing(err))) throw err;
    noteMissingTable('get');
    return null;
  }
}

/**
 * Delete the viewer's grants for the consumer from every source NOT in `keep`. Returns how many
 * went. A source the consumer no longer imports from loses its grant here, so declaring it again
 * later prompts again.
 */
async function pruneStorageImportGrants(opts: {
  userId: number;
  consumerAppBlockId: string;
  keep: readonly string[];
}): Promise<number> {
  const client = dbWrite as unknown as RawClient;
  const rows = (await client.$queryRaw`
    DELETE FROM "app_storage_import_grants"
    WHERE "user_id" = ${opts.userId}
      AND "consumer_app_block_id" = ${opts.consumerAppBlockId}
      AND NOT ("source_app_block_id" = ANY(${[...opts.keep]}::text[]))
    RETURNING 1
  `) as unknown[];
  return rows.length;
}

/**
 * Record the viewer's consent for the consumer: one row per source, holding exactly the
 * collections and access the prompt showed (a re-consent replaces them), and no row for a source
 * the prompt did not name. PROMPTED CONSENT ONLY: `blocks.grantScopes`.
 */
export async function recordStorageImportGrants(opts: {
  userId: number;
  consumerAppBlockId: string;
  grants: ReadonlyArray<{ sourceAppBlockId: string } & StorageImportGrant>;
}): Promise<void> {
  const bySource = new Map<string, StorageImportGrant>();
  for (const g of opts.grants) {
    if (g.sourceAppBlockId === opts.consumerAppBlockId) continue;
    bySource.set(g.sourceAppBlockId, { collections: [...g.collections], access: g.access });
  }
  const sources = [...bySource.keys()];
  // Collection names cannot hold a comma (`APP_STORAGE_COLLECTION_NAME_RE`), so each source's
  // list travels as one joined string in a parallel array.
  const collections = sources.map((s) => bySource.get(s)!.collections.join(','));
  const access = sources.map((s) => bySource.get(s)!.access);
  const client = dbWrite as unknown as RawClient;
  try {
    if (sources.length > 0) {
      await client.$queryRaw`
        INSERT INTO "app_storage_import_grants"
          ("user_id", "consumer_app_block_id", "source_app_block_id", "collections", "access")
        SELECT
          ${opts.userId}::integer,
          ${opts.consumerAppBlockId}::text,
          g.source,
          string_to_array(g.collections, ','),
          g.access
        FROM unnest(${sources}::text[], ${collections}::text[], ${access}::text[])
          AS g(source, collections, access)
        ON CONFLICT ("user_id", "consumer_app_block_id", "source_app_block_id")
        DO UPDATE SET
          "collections" = EXCLUDED."collections",
          "access" = EXCLUDED."access",
          "granted_at" = CURRENT_TIMESTAMP
        RETURNING 1
      `;
    }
    await pruneStorageImportGrants({
      userId: opts.userId,
      consumerAppBlockId: opts.consumerAppBlockId,
      keep: sources,
    });
  } catch (err) {
    if (!(await isLedgerMissing(err))) throw err;
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
    if (!(await isLedgerMissing(err))) throw err;
    noteMissingTable('revoke');
    return false;
  }
}

const ALL_FEATURES = Object.fromEntries(
  Object.keys(APP_STORAGE_ENABLED_FEATURES).map((f) => [f, true])
) as Record<AppStorageFeature, boolean>;

export type ResolvedStorageImport = {
  /** The source app's blockId, as the manifest names it. */
  from: string;
  collections: string[];
  access: AppStorageImportAccess;
  /** The approved source app, or null when none can be reached (see `unavailable`). */
  source: { appBlockId: string; name: string } | null;
  /** Set when an approved app holds the blockId but this host may not show it (`host` given). */
  unavailable?: 'source_rating';
};

/**
 * Every import a consumer manifest declares, each resolved to the APPROVED app that holds its
 * blockId (null when none does). A manifest whose storage does not parse declares none.
 *
 * With `host` (the consent surfaces), a source whose rating the host may not show
 * (`ratingAllowedOnHost`, the mint's rule) resolves as unavailable too, so no grant is offered or
 * written for it there; the storage route applies the same rule to the token's ceiling. The mint
 * passes no host: its coverage and pruning must not drop a grant given on another host.
 */
export async function resolveDeclaredImports(
  manifest: unknown,
  opts: { host?: string } = {}
): Promise<ResolvedStorageImport[]> {
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
    const { name, contentRating } = (row?.manifest ?? {}) as {
      name?: unknown;
      contentRating?: unknown;
    };
    const base = { from, collections: [...decl.collections], access: decl.access };
    if (!row) return { ...base, source: null };
    if (
      opts.host !== undefined &&
      !ratingAllowedOnHost(typeof contentRating === 'string' ? contentRating : null, opts.host)
    ) {
      return { ...base, source: null, unavailable: 'source_rating' as const };
    }
    return {
      ...base,
      source: { appBlockId: row.id, name: typeof name === 'string' ? name : from },
    };
  });
}

/**
 * Whether the viewer's per-source grants cover every source the consumer can reach today (every
 * declared import whose blockId an approved app holds), each by `importGrantCovers`. The mint
 * signs `apps:storage:import` only when this holds, so a source added by a later version, or an
 * import a later version widens, is prompted for. A declared source no approved app holds needs
 * no grant: nothing can be reached through it, and no grant could be written for it.
 *
 * It also drops the viewer's grants for sources the consumer no longer reaches (no longer
 * declared, or no longer approved), so a source declared again later is prompted again rather
 * than covered by a grant the viewer gave an earlier version. ⚠️ LAZY: that happens only when
 * this viewer mints a token while the source is absent. A viewer who never opens the app during
 * that window keeps the old row, which then still covers a re-added import exactly as wide as
 * what they were shown (never a wider one).
 */
export async function isImportScopeCovered(opts: {
  userId: number;
  consumerAppBlockId: string;
  manifest: unknown;
}): Promise<boolean> {
  // A manifest whose storage does not parse covers nothing, and prunes nothing: it says nothing
  // about which sources the app still imports from.
  if (parseManifestStorage(opts.manifest, ALL_FEATURES).errors.length > 0) return false;
  const imports = await resolveDeclaredImports(opts.manifest);
  const granted = await listStorageImportGrants({
    userId: opts.userId,
    consumerAppBlockId: opts.consumerAppBlockId,
    db: 'write',
  });
  const reachable = imports.filter((i) => i.source !== null);
  const keep = reachable.map((i) => i.source!.appBlockId);
  if ([...granted.keys()].some((id) => !keep.includes(id))) {
    await pruneStorageImportGrants({
      userId: opts.userId,
      consumerAppBlockId: opts.consumerAppBlockId,
      keep,
    });
  }
  return reachable.every((i) => importGrantCovers(granted.get(i.source!.appBlockId), i));
}

/**
 * The comparable form of an import list: one entry per source, sorted, each with its collections
 * sorted. Two lists are the same declaration exactly when these are equal.
 */
export function canonicalImports(
  imports: ReadonlyArray<{
    from: string;
    collections: Iterable<string>;
    access: AppStorageImportAccess;
  }>
): string {
  return JSON.stringify(
    [...imports]
      .map((i) => ({ from: i.from, collections: [...i.collections].sort(), access: i.access }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  );
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
