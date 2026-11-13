import type { Pool } from 'pg';
import { assertVectorSyncConfig, config, domainEmbedEnabled } from '@/config';
import { logger } from '@/utils/logger';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { Embedder } from '../embedder';
import type { VectorStore } from '../qdrant';
import {
  emptyStats,
  syncIds,
  type Domain,
  type DomainPayload,
  type DomainStore,
  type SyncStats,
} from './sync';

export type BackfillOptions = {
  from: number;
  to: number;
  page: number;
  limit?: number;
  dryRun?: boolean;
};

/** Walks the domain's ids below `to` down to `from`, a page at a time. */
export async function backfillDomain<P extends DomainPayload>(
  domain: Pick<Domain<P>, 'name' | 'table' | 'getDocs'>,
  opts: BackfillOptions,
  deps: {
    pg: Pick<Pool, 'query'>;
    store: DomainStore<P> & Pick<VectorStore<P>, 'idsInRange'>;
    embedder: Pick<Embedder, 'embed'> | null;
  }
): Promise<{ stats: SyncStats; next: number; complete: boolean }> {
  const stats = emptyStats();
  let cursor = opts.to;
  while (cursor > opts.from) {
    const { rows } = await deps.pg.query<{ id: number }>(
      `SELECT id FROM "${domain.table}" WHERE id >= $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
      [opts.from, cursor, opts.page]
    );
    // A short page is the last one: it covers the rest of the range.
    const lo = rows.length < opts.page ? opts.from : rows[rows.length - 1].id;
    const ids = rows.map((r) => r.id);
    // A hard-deleted row has no row left; only the collection still holds its id.
    const known = new Set(ids);
    ids.push(...(await deps.store.idsInRange(lo, cursor)).filter((id) => !known.has(id)));
    const page = await syncIds(domain.getDocs, ids, { ...deps, dryRun: opts.dryRun });
    for (const key of Object.keys(stats) as Array<keyof SyncStats>) stats[key] += page[key];
    cursor = lo;
    logger.info({ next: cursor, page, total: stats }, `${domain.name}-backfill: page done`);
    if (opts.limit !== undefined && stats.eligible - stats.failed >= opts.limit)
      return { stats, next: cursor, complete: false };
  }
  return { stats, next: opts.from, complete: true };
}

/** The store's methods as plain functions, so they survive a spread. */
function bind<P extends DomainPayload>(store: VectorStore<P>) {
  return {
    payloadFields: store.payloadFields.bind(store),
    idsInRange: store.idsInRange.bind(store),
    delete: store.delete.bind(store),
    setPayloads: store.setPayloads.bind(store),
    upsert: store.upsert.bind(store),
    assertModel: store.assertModel.bind(store),
  };
}

export function parseBackfillArgs(args: string[]) {
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return undefined;
    if (args[i + 1] === undefined) throw new Error(`--${name} needs a value`);
    return args[i + 1];
  };
  const int = (name: string, fallback?: number) => {
    const raw = flag(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (value !== undefined && (!Number.isInteger(value) || value < 0))
      throw new Error(`--${name} must be a non-negative integer`);
    return value;
  };
  const to = int('to');
  const from = int('from', 0)!;
  const page = int('page', 500)!;
  const limit = int('limit');
  if (to === undefined || to <= from || page < 1 || page > 5000 || limit === 0)
    throw new Error(
      '--to <id> is required, above --from; --page is 1 to 5000; --limit is at least 1'
    );
  return {
    from,
    to,
    page,
    limit,
    domain: flag('domain'),
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm'),
    stampCatalog: args.includes('--stamp-catalog'),
  };
}

/**
 * The backfill command for one domain: --to <id> [--from <id>] [--limit N] [--page 500]
 * [--dry-run] [--confirm] [--stamp-catalog]. Each page logs `next`, the --to that resumes after
 * it. --limit N stops after the first page by which N eligible rows were synced, for a first
 * slice. --stamp-catalog records catalogBuiltAt and catalogPointsAtBuild on the collection when
 * the walk reaches --from.
 */
export async function runBackfill<P extends DomainPayload>(
  domain: Domain<P>,
  args: ReturnType<typeof parseBackfillArgs>
) {
  assertVectorSyncConfig();
  const log = `${domain.name}-backfill`;
  if (!args.dryRun && !args.confirm) throw new Error('Writing needs --confirm (or pass --dry-run)');
  if (!args.dryRun && !domainEmbedEnabled(domain.name, domain.embedByDefault))
    throw new Error(
      `VECTOR_SYNC_EMBED_ENABLED or VECTOR_${domain.name.toUpperCase()}_EMBED_ENABLED is off; ` +
        'embedding is a paid call'
    );

  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
    log,
    (m, err) => logger.error({ err }, m)
  );
  const store = domain.store();
  try {
    if (!args.dryRun) await store.bootstrap({ alias: domain.alias() });
    // A dry run creates nothing, so before the first real run there is no collection to read.
    const exists = await store.exists();
    const empty = { payloadFields: async () => new Map(), idsInRange: async () => [] };
    const result = await backfillDomain(domain, args, {
      pg,
      store: exists ? store : { ...bind(store), ...empty },
      embedder: args.dryRun ? null : Embedder.fromConfig('low'),
    });
    logger.info(result, `${log}: done`);
    if (args.dryRun) {
      // One real document, to check its length against the embedder's limit before paying.
      const { rows } = await pg.query<{ id: number }>(
        `SELECT id FROM "${domain.table}" WHERE id < $1 ORDER BY id DESC LIMIT 50`,
        [args.to]
      );
      const [sample] = (
        await domain.getDocs(
          pg,
          rows.map((r) => r.id)
        )
      ).entries();
      if (sample) {
        const [id, { search_text }] = sample;
        logger.info({ id, chars: search_text.length, search_text }, `${log}: sample`);
      }
    }
    if (args.stampCatalog && result.complete && !args.dryRun) {
      await store.setMetadata({
        catalogBuiltAt: new Date().toISOString(),
        catalogPointsAtBuild: await store.count(),
      });
    }
  } finally {
    await pg.end();
  }
}
