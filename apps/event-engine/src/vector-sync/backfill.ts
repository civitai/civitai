/**
 * Backfill: embeds every eligible image at or below a watermark id, newest first.
 *
 *   node dist/vector-sync/backfill.js run --watermark <id> [--limit N] [--dry-run] [--confirm]
 *        [--floor <id>] [--span 5000] [--pages 2] [--name images] [--cursor-file path]
 *        [--without-image-cdc] [--max-rate <writes/s>] [--window HH:MM-HH:MM (UTC)]
 *   node dist/vector-sync/backfill.js pause|resume|status|reset [--name images]
 *   node dist/vector-sync/backfill.js set-inflight|set-steps-per-second <n|clear> [--name images]
 *
 * set-* lower a running backfill's in-flight jobs or step rate within a minute, without a
 * restart; they never raise it above VECTOR_EMBED_MAX_IN_FLIGHT / VECTOR_EMBED_MAX_STEPS_PER_SECOND.
 *
 * Pages are id windows, not LIMIT queries, so a page's cost is bounded by its span however
 * sparse eligibility is there. The cursor (the exclusive upper id of the next page) only moves
 * past a page once every page above it is written, so a restart resumes without a gap. Points
 * that already exist are not re-embedded, so resuming over a page repeats only payload writes.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertVectorSyncConfig, config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { fileRunState, redisRunState, type RunLimits, type RunState } from './cursor';
import { Embedder } from './embedder';
import { VectorStore } from './qdrant';
import { getImageRowsInRange } from './source';
import {
  addStats,
  connectorBlock,
  embedBlockedReason,
  emptyStats,
  syncRows,
  type SyncDeps,
} from './sync';

export type BackfillOptions = {
  watermark: number;
  floor: number;
  span: number;
  pages: number;
  /** Stop after this many eligible images. */
  limit?: number;
  logEveryMs?: number;
  /** Qdrant writes (points embedded, rewritten or deleted) per second, averaged per page. */
  maxRate?: number;
  /** Start new pages only inside this UTC window, e.g. "22:00-06:00" (may wrap midnight). */
  window?: string;
};

/** Minutes after midnight of each end of an `HH:MM-HH:MM` window; throws on a bad one. */
export function parseWindow(window: string): [number, number] {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(window);
  if (!m) throw new Error(`--window must be HH:MM-HH:MM (UTC), got ${window}`);
  const [from, to] = [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  if (from === to) throw new Error('--window start and end must differ');
  return [from, to];
}

export function inWindow(ms: number, [from, to]: [number, number]) {
  const d = new Date(ms);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

export type BackfillResult = ReturnType<typeof emptyStats> & {
  scanned: number;
  cursor: number;
  done: boolean;
};

type BackfillDeps = SyncDeps & {
  state: RunState;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Why embedding should pause right now (the connector stopped streaming Image), if it should. */
  gateCheck?: () => Promise<string | null>;
  gateEveryMs?: number;
  /** True once another run may own the cursor; this one then stops writing it. */
  leaseLost?: () => boolean;
  now?: () => number;
};

const LEASE_MS = 120_000;

/** Holds the run's lease for its whole length, so a second copy refuses to start. */
export async function runBackfill(
  opts: BackfillOptions,
  deps: BackfillDeps
): Promise<BackfillResult> {
  if (deps.dryRun) return runPages(opts, deps);
  const owner = randomUUID();
  if (!(await deps.state.acquireLease(owner, LEASE_MS))) {
    throw new Error('another run of this backfill holds its lease; refusing to start a second');
  }
  let lost = false;
  const renew = setInterval(() => {
    deps.state
      .renewLease(owner, LEASE_MS)
      .then((held) => {
        if (!held) lost = true;
      })
      .catch((err) => logger.warn({ err }, 'vector-backfill: lease renewal failed'));
  }, LEASE_MS / 4);
  try {
    const result = await runPages(opts, {
      ...deps,
      shouldStop: () => lost || !!deps.shouldStop?.(),
      leaseLost: () => lost,
    });
    if (lost) throw new Error('lost the backfill lease; stopped so two runs do not overlap');
    return result;
  } finally {
    clearInterval(renew);
    await deps.state.releaseLease(owner).catch(() => undefined);
  }
}

async function runPages(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const window = opts.window ? parseWindow(opts.window) : null;
  // The disk Qdrant writes to is shared, so pages are paced: each finished page pushes the next
  // start back by its writes / maxRate.
  let nextPageAt = 0;
  const holdReason = () => {
    if (window && !inWindow(now(), window)) return `outside window ${opts.window} UTC`;
    if (now() < nextPageAt) return 'rate limit';
    return null;
  };
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
        writesPerSec: Math.round(
          (total.embedded + total.updated + total.deleted) / Math.max(secs, 1)
        ),
        maxRate: opts.maxRate ?? null,
        window: opts.window ?? null,
      },
      msg
    );
  };

  // Pages run `pages` at a time; `done` tracks which have finished so the cursor only advances
  // over a contiguous run from the top.
  const finished = new Set<number>();
  const inFlight = new Map<number, Promise<void>>();
  let failure: unknown = null;

  const advance = async () => {
    while (finished.has(committed)) {
      finished.delete(committed);
      committed = Math.max(opts.floor, committed - opts.span);
      if (!deps.dryRun && !deps.leaseLost?.()) await deps.state.setCursor(committed);
    }
  };

  const runPage = async (hi: number) => {
    const lo = Math.max(opts.floor, hi - opts.span);
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await getImageRowsInRange(deps.pg as Pool, lo, hi);
        const stats = await syncRows(rows, [], deps);
        total.scanned += rows.length;
        addStats(total, stats);
        if (opts.maxRate) {
          const writes = stats.embedded + stats.updated + stats.deleted;
          nextPageAt = Math.max(now(), nextPageAt) + (writes / opts.maxRate) * 1000;
        }
        return;
      } catch (err) {
        // Retry a blip (Qdrant, Postgres); a model mismatch repeats, and each retry pays.
        const name = (err as Error).name;
        if (attempt >= 3 || name === 'ModelMismatchError' || name === 'MixedStampError') throw err;
        logger.warn({ err, lo, hi, attempt }, 'vector-backfill: page failed; retrying');
        await sleep(5000 * (attempt + 1));
      }
    }
  };

  // Re-checked during the run, which lasts days: if the connector stops streaming Image, blocks
  // stop reaching the index, so new pages wait until it streams again.
  let gateBlocked: string | null = null;
  let gateCheckedAt = -Infinity;
  const checkGate = async () => {
    const every = deps.gateEveryMs ?? (gateBlocked ? 30_000 : 5 * 60_000);
    if (!deps.gateCheck || Date.now() - gateCheckedAt < every) return;
    gateCheckedAt = Date.now();
    const reason = await deps
      .gateCheck()
      .catch((err) => `gate check failed: ${(err as Error).message}`);
    if (reason !== gateBlocked) {
      logger.warn(
        { reason },
        reason ? 'vector-backfill: paused by gate' : 'vector-backfill: gate passes'
      );
    }
    gateBlocked = reason;
  };

  while (!failure) {
    await checkGate();
    const stop =
      next <= opts.floor ||
      (opts.limit !== undefined && total.eligible >= opts.limit) ||
      deps.shouldStop?.();
    const held = gateBlocked ?? holdReason();
    if (!stop && !held && !(await deps.state.isPaused()) && inFlight.size < opts.pages) {
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
      // Held with nothing running: the pause flag, the gate, the window or the rate limit.
      if (Date.now() - lastLog > 60_000) {
        log(`vector-backfill: waiting (${held ?? 'paused'})`);
        lastLog = Date.now();
      }
      await sleep(held === 'rate limit' ? Math.min(5000, Math.max(0, nextPageAt - now())) : 5000);
      continue;
    }
    await Promise.race(inFlight.values());

    await advance();
    if (Date.now() - lastLog > (opts.logEveryMs ?? 30_000)) {
      log('vector-backfill: progress');
      lastLog = Date.now();
    }
  }
  await Promise.allSettled(inFlight.values());
  // Pages above a failure that finished meanwhile still count.
  await advance();
  if (failure) throw failure;

  total.cursor = committed;
  total.done = committed <= opts.floor;
  log(total.done ? 'vector-backfill: complete' : 'vector-backfill: stopped');
  return total;
}

const LIMIT_COMMANDS: Record<string, keyof RunLimits | undefined> = {
  'set-inflight': 'inFlight',
  'set-steps-per-second': 'stepsPerSecond',
};

/** Re-read so `set-*` reach a running backfill without a restart. */
const LIMITS_EVERY_MS = 30_000;

/** Applies the run's `set-*` limits now and every LIMITS_EVERY_MS; returns a stop function. */
export async function watchRunLimits(
  state: Pick<RunState, 'getLimits'>,
  embedder: Pick<Embedder, 'setLimits'>,
  everyMs = LIMITS_EVERY_MS
) {
  let last = '';
  const apply = async () => {
    const limits = await state.getLimits();
    embedder.setLimits(limits);
    if (JSON.stringify(limits) !== last) {
      last = JSON.stringify(limits);
      logger.info({ limits }, 'vector-backfill: runtime limits');
    }
  };
  await apply();
  const timer = setInterval(() => {
    apply().catch((err) => logger.warn({ err }, 'vector-backfill: reading limits failed'));
  }, everyMs);
  return () => clearInterval(timer);
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
    if (v === true) throw new Error(`--${name} needs a value`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };
  const positive = (name: string) => {
    if (flags[name] === true) throw new Error(`--${name} needs a value`);
    const n = Number(flags[name]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  return { command, flags, int, positive };
}

async function main() {
  assertVectorSyncConfig();
  const argv = process.argv.slice(2);
  // set-* take their value as a positional argument.
  const limitValue = argv[0]?.startsWith('set-') ? argv.splice(1, 1)[0] : undefined;
  const { command, flags, int, positive } = parseArgs(argv);
  const name = String(flags.name ?? 'images');
  // Logged by every command: pause or status run with another VECTOR_COLLECTION addresses
  // another run.
  const run = { name, collection: config.vectorSync.collection };
  const state =
    typeof flags['cursor-file'] === 'string'
      ? fileRunState(flags['cursor-file'])
      : // Keyed by collection too: a new collection (a model change) starts from its own watermark.
        await redisRunState(`backfill:${config.vectorSync.collection}:${name}`);
  try {
    if (command === 'pause' || command === 'resume') {
      await state.setPaused(command === 'pause');
      logger.info(run, `vector-backfill: ${command}d`);
      return;
    }
    if (command === 'status') {
      logger.info(
        {
          ...run,
          cursor: await state.getCursor(),
          paused: await state.isPaused(),
          limits: await state.getLimits(),
          ceilings: {
            inFlight: config.vectorSync.embedMaxInFlight,
            stepsPerSecond: config.vectorSync.embedMaxStepsPerSecond,
          },
        },
        'vector-backfill: status'
      );
      return;
    }
    const limitName = LIMIT_COMMANDS[command];
    if (limitName) {
      const value = limitValue === 'clear' ? null : Number(limitValue);
      if (value !== null && !(Number.isInteger(value) && value >= 1)) {
        throw new Error(`${command} needs a positive integer or "clear"`);
      }
      await state.setLimit(limitName, value);
      logger.info({ ...run, [limitName]: value }, `vector-backfill: ${command}`);
      return;
    }
    if (command === 'reset') {
      await state.reset();
      logger.info(run, 'vector-backfill: reset');
      return;
    }
    if (command !== 'run') throw new Error(`unknown command ${command}`);

    const watermark = int('watermark');
    if (watermark === undefined) throw new Error('--watermark <id> is required');
    const dryRun = flags['dry-run'] === true;
    // Fail on a bad window or rate before any lease or connection is taken.
    if (flags.window !== undefined) parseWindow(String(flags.window));
    if (flags['max-rate'] !== undefined) positive('max-rate');
    for (const name of ['limit', 'floor', 'span', 'pages']) int(name);
    let gateCheck: (() => Promise<string | null>) | undefined;
    if (!dryRun) {
      if (flags.confirm !== true) throw new Error('Writing needs --confirm (or pass --dry-run)');
      const withoutImageCdc = flags['without-image-cdc'] === true;
      // Blocks are not streamed then, so keep such a run to a bounded canary.
      if (withoutImageCdc && flags.limit === undefined) {
        throw new Error('--without-image-cdc needs --limit');
      }
      const blocked = await embedBlockedReason({ withoutImageCdc });
      if (blocked) throw new Error(`Not embedding: ${blocked}`);
      if (!withoutImageCdc) gateCheck = () => connectorBlock();
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
    const embedder = dryRun ? null : Embedder.fromConfig('low');
    const stopWatching = embedder ? await watchRunLimits(state, embedder) : () => undefined;
    try {
      await runBackfill(
        {
          watermark,
          floor: int('floor', 0)!,
          span: Math.max(1, int('span', 5000)!),
          pages: Math.max(1, int('pages', 2)!),
          limit: int('limit'),
          maxRate: flags['max-rate'] === undefined ? undefined : positive('max-rate'),
          window: flags.window === undefined ? undefined : String(flags.window),
        },
        {
          pg,
          store,
          embedder,
          dryRun,
          state,
          gateCheck,
          shouldStop: () => stopping,
        }
      );
    } finally {
      stopWatching();
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
