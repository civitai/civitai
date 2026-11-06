/**
 * Fills the models collection, newest model first:
 *   node dist/vector-sync/models/backfill.js --to <id> [--from <id>] [--limit N] [--page 500]
 *     [--dry-run] [--confirm] [--stamp-catalog]
 * Each page logs `next`, the --to that resumes after it. --limit stops once N models have a
 * point (written or already current), for a first slice. --stamp-catalog records catalogBuiltAt
 * and catalogPointsAtBuild on the collection when the walk reaches --from.
 */
import type { Pool } from 'pg';
import { assertVectorSyncConfig, config } from '@/config';
import { logger } from '@/utils/logger';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { Embedder } from '../embedder';
import { modelVectorStore } from './collection';
import { syncModelIds, emptyModelStats, type ModelStore, type ModelSyncStats } from './sync';

export type ModelBackfillOptions = {
  from: number;
  to: number;
  page: number;
  limit?: number;
  dryRun?: boolean;
};

/** Walks ids below `to` down to `from`, a page at a time. Returns the stats and where it stopped. */
export async function backfillModels(
  opts: ModelBackfillOptions,
  deps: { pg: Pick<Pool, 'query'>; store: ModelStore; embedder: Pick<Embedder, 'embed'> | null }
): Promise<{ stats: ModelSyncStats; next: number; complete: boolean }> {
  const stats = emptyModelStats();
  let cursor = opts.to;
  while (cursor > opts.from) {
    const { rows } = await deps.pg.query<{ id: number }>(
      `SELECT id FROM "Model" WHERE id >= $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
      [opts.from, cursor, opts.page]
    );
    if (!rows.length) break;
    const page = await syncModelIds(
      rows.map((r) => r.id),
      { ...deps, dryRun: opts.dryRun }
    );
    for (const key of Object.keys(stats) as Array<keyof ModelSyncStats>) stats[key] += page[key];
    cursor = rows[rows.length - 1].id;
    logger.info({ next: cursor, page, total: stats }, 'model-backfill: page done');
    if (opts.limit !== undefined && stats.eligible - stats.failed >= opts.limit)
      return { stats, next: cursor, complete: false };
  }
  return { stats, next: opts.from, complete: true };
}

function parseArgs(args: string[]) {
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
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
  if (to === undefined || to <= from || page < 1 || page > 5000)
    throw new Error('--to <id> is required, above --from; --page is 1 to 5000');
  return {
    from,
    to,
    page,
    limit: int('limit'),
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm'),
    stampCatalog: args.includes('--stamp-catalog'),
  };
}

async function main() {
  assertVectorSyncConfig();
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.confirm) throw new Error('Writing needs --confirm (or pass --dry-run)');
  if (!args.dryRun && !config.vectorSync.embedEnabled)
    throw new Error('VECTOR_SYNC_EMBED_ENABLED is off; embedding is a paid call');

  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
    'model-backfill',
    (m, err) => logger.error({ err }, m)
  );
  const store = modelVectorStore();
  try {
    if (!args.dryRun) await store.bootstrap({ alias: config.vectorSync.modelAlias });
    const result = await backfillModels(args, {
      pg,
      store,
      embedder: args.dryRun ? null : Embedder.fromConfig('low'),
    });
    logger.info(result, 'model-backfill: done');
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

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'model-backfill: failed');
    process.exit(1);
  });
}
