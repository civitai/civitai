/**
 * Backfill: embeds every eligible image at or below a watermark id, newest first.
 *
 *   node dist/vector-sync/backfill.js run --watermark <id> [--limit N] [--dry-run] [--confirm]
 *        [--floor <id>] [--span 5000] [--pages 2] [--name images] [--cursor-file path]
 *   node dist/vector-sync/backfill.js pause|resume|status|reset [--name images]
 *
 * Pages are id windows, not LIMIT queries, so a page's cost is bounded by its span however
 * sparse eligibility is there. The cursor (the exclusive upper id of the next page) only moves
 * past a page once every page above it is written, so a restart resumes without a gap. Points
 * that already exist are not re-embedded, so resuming over a page repeats only payload writes.
 */
import type { Pool } from 'pg';
import { config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { fileRunState, redisRunState, type RunState } from './cursor';
import { Embedder } from './embedder';
import { VectorStore } from './qdrant';
import { getImageRowsInRange } from './source';
import { addStats, emptyStats, syncRows, type SyncDeps } from './sync';

export type BackfillOptions = {
  watermark: number;
  floor: number;
  span: number;
  pages: number;
  /** Stop after this many eligible images. */
  limit?: number;
  logEveryMs?: number;
};

export type BackfillResult = ReturnType<typeof emptyStats> & {
  scanned: number;
  cursor: number;
  done: boolean;
};

export async function runBackfill(
  opts: BackfillOptions,
  deps: SyncDeps & {
    state: RunState;
    shouldStop?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<BackfillResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const total = { ...emptyStats(), scanned: 0, cursor: 0, done: false };
  const start = (await deps.state.getCursor()) ?? opts.watermark + 1;
  let next = Math.min(start, opts.watermark + 1);
  let committed = next;
  const started = Date.now();
  let lastLog = started;

  const log = (msg: string) => {
    const secs = (Date.now() - started) / 1000;
    logger.info(
      {
        ...total,
        cursor: committed,
        perSec: Math.round((total.embedded + total.updated) / Math.max(secs, 1)),
      },
      msg
    );
  };

  // Pages run `pages` at a time; `done` tracks which have finished so the cursor only advances
  // over a contiguous run from the top.
  const finished = new Set<number>();
  const inFlight = new Map<number, Promise<void>>();
  let failure: unknown = null;

  const runPage = async (hi: number) => {
    const lo = Math.max(opts.floor, hi - opts.span);
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await getImageRowsInRange(deps.pg as Pool, lo, hi);
        const stats = await syncRows(rows, [], deps);
        total.scanned += rows.length;
        addStats(total, stats);
        return;
      } catch (err) {
        // Transient (a Qdrant or Postgres blip); a mismatched model or a config error repeats.
        if (attempt >= 3 || (err as Error).name === 'ModelMismatchError') throw err;
        logger.warn({ err, lo, hi, attempt }, 'vector-backfill: page failed; retrying');
        await sleep(5000 * (attempt + 1));
      }
    }
  };

  while (!failure) {
    const stop =
      next <= opts.floor ||
      (opts.limit !== undefined && total.eligible >= opts.limit) ||
      deps.shouldStop?.();
    if (!stop && !(await deps.state.isPaused()) && inFlight.size < opts.pages) {
      const hi = next;
      next = Math.max(opts.floor, hi - opts.span);
      inFlight.set(
        hi,
        runPage(hi)
          .then(() => void finished.add(hi))
          .catch((err) => void (failure = err))
          .finally(() => inFlight.delete(hi))
      );
      continue;
    }
    if (!inFlight.size) {
      if (stop) break;
      // Paused with nothing running.
      if (Date.now() - lastLog > 60_000) {
        log('vector-backfill: paused');
        lastLog = Date.now();
      }
      await sleep(5000);
      continue;
    }
    await Promise.race(inFlight.values());

    while (finished.has(committed)) {
      finished.delete(committed);
      committed = Math.max(opts.floor, committed - opts.span);
      if (!deps.dryRun) await deps.state.setCursor(committed);
    }
    if (Date.now() - lastLog > (opts.logEveryMs ?? 30_000)) {
      log('vector-backfill: progress');
      lastLog = Date.now();
    }
  }
  await Promise.allSettled(inFlight.values());
  if (failure) throw failure;

  total.cursor = committed;
  total.done = committed <= opts.floor;
  log(total.done ? 'vector-backfill: complete' : 'vector-backfill: stopped');
  return total;
}

function parseArgs(argv: string[]) {
  const [command = 'run', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = rest[++i];
  }
  const int = (name: string, fallback?: number) => {
    const v = flags[name];
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };
  return { command, flags, int };
}

async function main() {
  const { command, flags, int } = parseArgs(process.argv.slice(2));
  const name = String(flags.name ?? 'images');
  const state =
    typeof flags['cursor-file'] === 'string'
      ? fileRunState(flags['cursor-file'])
      : await redisRunState(`backfill:${name}`);
  try {
    if (command === 'pause' || command === 'resume') {
      await state.setPaused(command === 'pause');
      logger.info({ name }, `vector-backfill: ${command}d`);
      return;
    }
    if (command === 'status') {
      logger.info(
        { name, cursor: await state.getCursor(), paused: await state.isPaused() },
        'vector-backfill: status'
      );
      return;
    }
    if (command === 'reset') {
      await state.reset();
      logger.info({ name }, 'vector-backfill: reset');
      return;
    }
    if (command !== 'run') throw new Error(`unknown command ${command}`);

    const watermark = int('watermark');
    if (watermark === undefined) throw new Error('--watermark <id> is required');
    const dryRun = flags['dry-run'] === true;
    if (!dryRun && (flags.confirm !== true || !config.vectorSync.embedEnabled)) {
      throw new Error(
        'Writing needs --confirm and VECTOR_SYNC_EMBED_ENABLED=true (or pass --dry-run)'
      );
    }

    const pg = createGuardedPgPool(
      { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
      'vector-backfill',
      (m, err) => logger.error({ err }, m)
    );
    const store = VectorStore.fromConfig();
    if (!dryRun) await store.bootstrap();
    else if (!(await store.client.collectionExists(store.collection)).exists) {
      // Nothing is written in a dry run, so a missing collection just means no points yet.
      store.existing = async () => new Set();
    }
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        logger.info({ signal }, 'vector-backfill: finishing in-flight pages, then stopping');
        stopping = true;
      });
    }
    try {
      await runBackfill(
        {
          watermark,
          floor: int('floor', 0)!,
          span: int('span', 5000)!,
          pages: int('pages', 2)!,
          limit: int('limit'),
        },
        {
          pg,
          store,
          embedder: dryRun ? null : Embedder.fromConfig('low'),
          dryRun,
          state,
          shouldStop: () => stopping,
        }
      );
    } finally {
      await pg.end();
    }
  } finally {
    await state.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'vector-backfill: failed');
    process.exit(1);
  });
}
