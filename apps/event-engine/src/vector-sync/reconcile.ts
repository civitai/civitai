/**
 * Reconciler: per id bucket, compares the eligible ids in Postgres with the point ids in Qdrant
 * and re-syncs the difference (missing ids embed, extra ids are re-read and deleted if still
 * ineligible). Checks presence only, not payload freshness.
 *
 *   node dist/vector-sync/reconcile.js --from <id> --to <id> [--bucket 100000] [--dry-run] [--confirm]
 */
import type { Pool } from 'pg';
import { config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { eligibleSql } from './eligibility';
import { Embedder } from './embedder';
import { VectorStore } from './qdrant';
import { addStats, embedBlockedReason, emptyStats, syncImageIds, type SyncDeps } from './sync';

export type BucketDiff = {
  lo: number;
  hi: number;
  postgres: number;
  qdrant: number;
  missing: number[];
  extra: number[];
};

export async function eligibleIdsInRange(
  pg: Pick<Pool, 'query'>,
  lo: number,
  hi: number
): Promise<number[]> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT i.id FROM "Image" i WHERE i.id >= $1 AND i.id < $2 AND ${eligibleSql('i')}`,
    [lo, hi]
  );
  return rows.map((r) => r.id);
}

export function diffIds(postgres: number[], qdrant: number[]) {
  const inQdrant = new Set(qdrant);
  const inPostgres = new Set(postgres);
  return {
    missing: postgres.filter((id) => !inQdrant.has(id)),
    extra: qdrant.filter((id) => !inPostgres.has(id)),
  };
}

export async function reconcile(
  { from, to, bucket }: { from: number; to: number; bucket: number },
  deps: SyncDeps & { store: SyncDeps['store'] & Pick<VectorStore, 'idsInRange'> }
) {
  const total = { ...emptyStats(), buckets: 0, drifted: 0, missing: 0, extra: 0 };
  // Newest first, like the backfill: recent drift matters most.
  for (let hi = to; hi > from; hi -= bucket) {
    const lo = Math.max(from, hi - bucket);
    const started = Date.now();
    const [pgIds, qdrantIds] = await Promise.all([
      eligibleIdsInRange(deps.pg, lo, hi),
      deps.store.idsInRange(lo, hi),
    ]);
    const { missing, extra } = diffIds(pgIds, qdrantIds);
    total.buckets++;
    total.missing += missing.length;
    total.extra += extra.length;
    if (missing.length || extra.length) {
      total.drifted++;
      if (!deps.dryRun) addStats(total, await syncImageIds([...missing, ...extra], deps));
    }
    logger.info(
      {
        lo,
        hi,
        postgres: pgIds.length,
        qdrant: qdrantIds.length,
        missing: missing.length,
        extra: extra.length,
        ms: Date.now() - started,
      },
      'vector-reconcile: bucket'
    );
  }
  logger.info(total, 'vector-reconcile: done');
  return total;
}

async function reconcileEmbedder() {
  const blocked = await embedBlockedReason();
  if (!blocked) return Embedder.fromConfig('low');
  logger.warn({ reason: blocked }, 'vector-reconcile: not embedding; missing ids are only counted');
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const from = Number(flag('from') ?? 0);
  const to = Number(flag('to'));
  const bucket = Number(flag('bucket') ?? 100_000);
  if (![from, to, bucket].every(Number.isInteger) || bucket <= 0 || to <= from) {
    throw new Error('--to <id> is required; --from and --bucket must be integers with from < to');
  }
  const dryRun = args.includes('--dry-run');
  if (!dryRun && !args.includes('--confirm'))
    throw new Error('Writing needs --confirm (or pass --dry-run)');

  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
    'vector-reconcile',
    (m, err) => logger.error({ err }, m)
  );
  const store = VectorStore.fromConfig();
  try {
    await reconcile(
      { from, to, bucket },
      {
        pg,
        store,
        // With embedding off, drift is still deleted and the missing ids are counted.
        embedder: dryRun ? null : await reconcileEmbedder(),
        dryRun,
      }
    );
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'vector-reconcile: failed');
    process.exit(1);
  });
}
