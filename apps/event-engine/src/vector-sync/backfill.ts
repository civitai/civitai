/**
 * Backfill: embeds every eligible image at or below a watermark id, newest first.
 *
 *   node dist/vector-sync/backfill.js run --watermark <id> [--limit N] [--dry-run] [--confirm]
 *        [--floor <id>] [--span 5000] [--name images] [--cursor-file path]
 *        [--without-image-cdc] [--max-rate <writes/s>] [--window HH:MM-HH:MM (UTC)]
 *   node dist/vector-sync/backfill.js pause|resume|status|reset [--name images]
 *   node dist/vector-sync/backfill.js set-inflight|set-steps-per-second <n|clear> [--name images]
 *
 * set-* lower a running backfill's in-flight jobs or step rate within a minute, without a
 * restart; they never raise it above VECTOR_EMBED_MAX_IN_FLIGHT / VECTOR_EMBED_MAX_STEPS_PER_SECOND.
 *
 * A pipeline, so one slow workflow holds back only the cursor: a reader pages id windows (spans,
 * not LIMIT queries, so a page's cost is bounded however sparse eligibility is) into a bounded
 * buffer; batches leave it only when the job budget and the step rate have room for them now; each
 * workflow's vectors are written as it returns, under --max-rate. The cursor (the exclusive upper
 * id of the next page to read on a restart) moves past a page only once every image in it, and in
 * every page above it, is written or counted failed, so a restart resumes without a gap. A
 * workflow not back within its deadline is counted failed and left to the reconciler, which
 * embeds eligible ids with no point. Points that already exist are not re-embedded, so resuming
 * over a page repeats only payload writes. --pages is ignored.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertVectorSyncConfig, config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { fileRunState, redisRunState, type RunLimits, type RunState } from './cursor';
import { Embedder, MAX_INPUTS_PER_WORKFLOW, takeBatch, type EmbedInput } from './embedder';
import { VectorStore } from './qdrant';
import { getImageRows, getImageRowsInRange, type ImagePayload } from './source';
import {
  addStats,
  connectorBlock,
  embedBlockedReason,
  emptyStats,
  prepareRows,
  vectorWriter,
  type SyncDeps,
} from './sync';

export type BackfillOptions = {
  watermark: number;
  floor: number;
  span: number;
  /** @deprecated Ignored: reading ahead is bounded by bufferSize and maxDistance. */
  pages?: number;
  /** Stop reading after this many eligible images. */
  limit?: number;
  logEveryMs?: number;
  /** Qdrant writes (points embedded, rewritten or deleted) per second. */
  maxRate?: number;
  /** Read and submit only inside this UTC window, e.g. "22:00-06:00" (may wrap midnight). */
  window?: string;
  /** Embed inputs read but not yet submitted; the reader waits while this many are buffered. */
  bufferSize?: number;
  /** How far, in ids, the reader may run ahead of the cursor while a straggler holds it. */
  maxDistance?: number;
  /** A workflow not back by then is counted failed, so the cursor can pass its images. */
  deadlineMs?: number;
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

/** The real Embedder has all of these; a fake without them is unbounded and unpaced. */
type PipelineEmbedder = Pick<Embedder, 'embed'> &
  Partial<Pick<Embedder, 'batchSize' | 'submitWaitMs' | 'submitAllowance' | 'sink'>> & {
    budget?: Pick<Embedder['budget'], 'capacity' | 'inFlight'>;
  };

type BackfillDeps = Omit<SyncDeps, 'embedder'> & {
  embedder: PipelineEmbedder | null;
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
/** Longest the loop waits before re-checking the pause flag, the gate, the window and deadlines. */
const TICK_MS = 5_000;
const BUFFER_SIZE = 2_000;
const MAX_DISTANCE = 500_000;
/** Past the 30-minute step timeout plus the embedder's own retries of a slow batch. */
const DEADLINE_MS = 45 * 60_000;
/** Attempts at a page read, or at a batch whose workflow failed systemically, before the run stops. */
const ATTEMPTS = 4;
/** Errors a retry repeats, each retry paying again. */
const FATAL = new Set(['ModelMismatchError', 'MixedStampError']);

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

type Page = { lo: number; outstanding: number };
type Batch = {
  steps: number;
  started: number;
  /** Ids neither written nor counted failed yet. */
  unresolved: Set<number>;
  expired: boolean;
  done?: Promise<void>;
};

async function runPages(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const window = opts.window ? parseWindow(opts.window) : null;
  const bufferSize = opts.bufferSize ?? BUFFER_SIZE;
  const maxDistance = opts.maxDistance ?? MAX_DISTANCE;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const embedder = deps.embedder;
  const total = { ...emptyStats(), scanned: 0, cursor: 0, done: false };
  const start = (await deps.state.getCursor()) ?? opts.watermark + 1;
  let next = Math.min(start, opts.watermark + 1);
  let committed = next;

  // Pages read and not yet passed by the cursor, top first. Each counts its unresolved images.
  const pages: Page[] = [];
  const queue: EmbedInput[] = [];
  const pending = new Map<number, { payload: ImagePayload; page: Page; attempt: number }>();
  const running = new Set<Batch>();
  let failure: unknown = null;
  let retryAt = 0;
  let submitted = 0;
  // Until the collection has a recorded model, one workflow at a time records it.
  let stamped = !!deps.dryRun || (await deps.store.isStamped());

  // The loop sleeps until something it waits on changes; `dirty` catches a change made while it
  // was busy, and a woken wait clears its timer so a finished run does not linger.
  let dirty = false;
  let wake: () => void = () => undefined;
  const kick = () => {
    dirty = true;
    wake();
  };
  const wait = async (ms: number) => {
    if (dirty) return;
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (deps.sleep) void deps.sleep(ms).then(resolve);
      else timer = setTimeout(resolve, ms);
    });
    clearTimeout(timer);
    wake = () => undefined;
  };

  // The disk Qdrant writes to is shared: each write reserves the next slot under maxRate. A
  // workflow's writes wait for theirs; a page's are charged after, and hold the next read back,
  // so the loop itself never waits on the rate.
  let writeAt = 0;
  const chargeWrites = (writes: number) => {
    if (!opts.maxRate || !writes) return 0;
    const at = Math.max(now(), writeAt);
    writeAt = at + (writes / opts.maxRate) * 1000;
    return at - now();
  };
  const paceWrites = async (writes: number) => {
    const wait = chargeWrites(writes);
    if (wait > 0) await sleep(wait);
  };
  const charge = async (writes: number) => void chargeWrites(writes);
  let readFailures = 0;
  let readRetryAt = 0;
  const readAt = () => Math.max(readRetryAt, opts.maxRate ? writeAt : 0);

  const holdReason = async () => {
    if (gateBlocked) return gateBlocked;
    if (window && !inWindow(now(), window)) return `outside window ${opts.window} UTC`;
    if (now() < retryAt) return 'retry backoff';
    if (await deps.state.isPaused()) return 'paused';
    return null;
  };

  const advance = async () => {
    while (pages.length && pages[0].outstanding === 0) {
      committed = pages.shift()!.lo;
      if (!deps.dryRun && !deps.leaseLost?.()) await deps.state.setCursor(committed);
    }
  };

  // A failed read is retried from the loop after a backoff, so pause and deadlines still run.
  const readPage = async () => {
    const hi = next;
    const lo = Math.max(opts.floor, hi - opts.span);
    try {
      const rows = await getImageRowsInRange(deps.pg as Pool, lo, hi);
      const prep = await prepareRows(rows, [], deps, charge);
      readFailures = 0;
      total.scanned += rows.length;
      addStats(total, prep.stats);
      const page = { lo, outstanding: prep.inputs.length };
      pages.push(page);
      for (const input of prep.inputs) {
        pending.set(Number(input.id), {
          payload: prep.payloads.get(Number(input.id))!,
          page,
          attempt: 0,
        });
        queue.push(input);
      }
      next = lo;
    } catch (err) {
      // Retry a blip (Qdrant, Postgres).
      if (++readFailures >= ATTEMPTS) throw err;
      logger.warn(
        { err, lo, hi, attempt: readFailures },
        'vector-backfill: page read failed; retrying'
      );
      readRetryAt = now() + 5000 * readFailures;
    }
  };

  const resolve = (batch: Batch, ids: Iterable<number>, failed = false) => {
    for (const id of ids) {
      if (!batch.unresolved.delete(id)) continue;
      const entry = pending.get(id)!;
      pending.delete(id);
      entry.page.outstanding--;
      if (failed) total.failed++;
    }
    kick();
  };

  const submit = (inputs: EmbedInput[]) => {
    const batch: Batch = {
      steps: inputs.length,
      started: now(),
      unresolved: new Set(inputs.map((i) => Number(i.id))),
      expired: false,
    };
    running.add(batch);
    submitted += inputs.length;
    const payloads = new Map(inputs.map((i) => [Number(i.id), pending.get(Number(i.id))!.payload]));
    const write = vectorWriter(payloads, total, deps, paceWrites);
    batch.done = (async () => {
      let error: unknown;
      let writeFailed: unknown;
      try {
        const result = await embedder!.embed(inputs, {
          acceptStamp: async (stamp) => {
            await deps.store.assertModel(stamp);
            stamped = true;
          },
          onVectors: async (vectors) => resolve(batch, await write(vectors)),
        });
        // Whatever was not stored as it came (a failed early write). These vectors are paid for,
        // so the write is retried here, never by re-embedding; if Qdrant stays down the run stops.
        for (let tries = 1; ; tries++) {
          try {
            resolve(batch, await write(result.vectors));
            break;
          } catch (err) {
            if (tries >= ATTEMPTS) {
              error = writeFailed = err;
              break;
            }
            logger.warn({ err, tries }, 'vector-backfill: writing vectors failed; retrying');
            await sleep(5000 * tries);
          }
        }
        resolve(batch, result.failed, true);
        if (!writeFailed) error = result.error ?? error;
      } catch (err) {
        error = err;
      }
      const left = inputs.filter((i) => batch.unresolved.has(Number(i.id)));
      const fatal = !!writeFailed || FATAL.has((error as Error | undefined)?.name ?? '');
      const attempt = Math.max(0, ...left.map((i) => pending.get(Number(i.id))!.attempt)) + 1;
      if (fatal || (left.length && attempt >= ATTEMPTS)) {
        failure ??= error ?? new Error('embedding returned no result for some images');
      } else if (left.length) {
        // Systemic (retries exhausted, a Qdrant write): the images go back to the front, re-read
        // as a page would be, so one stored before a failed re-check is checked, not re-embedded.
        logger.warn(
          { err: error, ids: left.length, attempt },
          'vector-backfill: batch failed; retrying'
        );
        let again = left;
        try {
          const ids = left.map((i) => Number(i.id));
          const rows = await getImageRows(deps.pg as Pool, ids);
          const found = new Set(rows.map((r) => r.id));
          const prep = await prepareRows(
            rows,
            ids.filter((id) => !found.has(id)),
            deps,
            charge
          );
          addStats(total, { ...prep.stats, eligible: 0 });
          again = prep.inputs;
          const kept = new Set(again.map((i) => i.id));
          resolve(
            batch,
            ids.filter((id) => !kept.has(String(id)))
          );
          for (const i of again) {
            const entry = pending.get(Number(i.id));
            if (entry) entry.payload = prep.payloads.get(Number(i.id))!;
          }
        } catch (err) {
          logger.warn({ err }, 'vector-backfill: re-reading a failed batch failed; resending it');
        }
        // The loop ran during the re-read: its deadline may have counted these failed meanwhile.
        again = again.filter((i) => batch.unresolved.has(Number(i.id)));
        for (const i of again) pending.get(Number(i.id))!.attempt = attempt;
        // Out of `running` before its images are back in the queue, so no new batch overlaps it.
        running.delete(batch);
        queue.unshift(...again);
        if (again.length) retryAt = now() + 5000 * attempt;
      }
    })()
      // A bug here must stop the run, not crash the process with workflows in flight.
      .catch((err) => void (failure ??= err))
      .finally(() => {
        running.delete(batch);
        kick();
      });
  };

  // A straggler is counted failed so the cursor can pass it; its workflow keeps its jobs, and its
  // vectors are still written if it returns.
  const expire = () => {
    for (const batch of running) {
      if (batch.expired || now() - batch.started < deadlineMs) continue;
      batch.expired = true;
      if (!batch.unresolved.size) continue;
      logger.warn(
        { ids: [...batch.unresolved], deadlineMs },
        'vector-backfill: workflow past its deadline; counted failed for the reconciler'
      );
      resolve(batch, [...batch.unresolved], true);
    }
  };

  // Re-checked during the run, which lasts days: if the connector stops streaming Image, blocks
  // stop reaching the index, so reading and submitting wait until it streams again.
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

  let last = { at: Date.now(), submitted: 0, written: 0 };
  const written = () => total.embedded + total.updated + total.deleted;
  const log = (msg: string, extra: Record<string, unknown> = {}) => {
    const at = Date.now();
    const secs = Math.max((at - last.at) / 1000, 1);
    let oldest = Infinity;
    for (const b of running) if (b.unresolved.size) oldest = Math.min(oldest, b.started);
    logger.info(
      {
        ...total,
        cursor: committed,
        submittedPerSec: Math.round((submitted - last.submitted) / secs),
        inFlight: embedder?.budget?.inFlight ?? [...running].reduce((n, b) => n + b.steps, 0),
        writtenPerSec: Math.round((written() - last.written) / secs),
        queued: queue.length,
        readerDistance: committed - next,
        oldestOutstandingSec: oldest === Infinity ? null : Math.round((now() - oldest) / 1000),
        maxRate: opts.maxRate ?? null,
        window: opts.window ?? null,
        sink: embedder?.sink?.stats() ?? null,
        ...extra,
      },
      msg
    );
    last = { at, submitted, written: written() };
  };
  const progress = setInterval(() => log('vector-backfill: progress'), opts.logEveryMs ?? 30_000);
  progress.unref?.();
  let heldLoggedAt = -Infinity;

  try {
    for (;;) {
      dirty = false;
      await checkGate();
      expire();
      await advance();
      const stopping = !!failure || !!deps.shouldStop?.();
      const held = stopping ? 'stopping' : await holdReason();
      const capacity = embedder?.budget?.capacity ?? Infinity;
      // Sized to what the account's quota has left, or embed() would split it into workflows
      // sent one by one, past a pause.
      const full = Math.min(embedder?.batchSize ?? MAX_INPUTS_PER_WORKFLOW, capacity);
      const size = embedder?.submitAllowance?.(full) ?? full;
      let inFlight = 0;
      for (const b of running) inFlight += b.steps;

      // Submit only what the budget and the embedder's own step-rate schedule take now, so
      // nothing waits inside the embedder: a pause or a lowered limit applies to the next batch.
      // Its schedule, not a copy, so its retries and re-submits hold new batches back too.
      const submitWait = embedder?.submitWaitMs ?? 0;
      if (
        !held &&
        queue.length &&
        (stamped || !running.size) &&
        size > 0 &&
        inFlight + Math.min(size, queue.length) <= capacity &&
        submitWait === 0
      ) {
        submit(takeBatch(queue, size));
        continue;
      }
      const readDone =
        next <= opts.floor || (opts.limit !== undefined && total.eligible >= opts.limit);
      const wantsRead =
        !held && !readDone && queue.length < bufferSize && committed - next < maxDistance;
      if (wantsRead && now() >= readAt()) {
        await readPage().catch((err) => void (failure ??= err));
        continue;
      }
      if (!running.size && (stopping || (readDone && !queue.length))) break;

      if (held && held !== 'stopping' && Date.now() - heldLoggedAt > 60_000) {
        log(`vector-backfill: waiting (${held})`);
        heldLoggedAt = Date.now();
      }
      let ms = TICK_MS;
      if (!held && queue.length && submitWait) ms = Math.min(ms, submitWait);
      if (wantsRead) ms = Math.min(ms, readAt() - now());
      if (held === 'retry backoff') ms = Math.min(ms, retryAt - now());
      for (const b of running) if (!b.expired) ms = Math.min(ms, b.started + deadlineMs - now());
      await wait(Math.max(0, ms));
    }
  } catch (err) {
    failure ??= err;
  } finally {
    clearInterval(progress);
  }
  // Paid-for vectors are written before the run returns, even when it fails.
  await Promise.allSettled([...running].map((b) => b.done));
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
    for (const name of ['limit', 'floor', 'span']) int(name);
    if (flags.pages !== undefined) {
      logger.warn(
        'vector-backfill: --pages is ignored; set-inflight and set-steps-per-second bound a run'
      );
    }
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
        logger.info({ signal }, 'vector-backfill: finishing in-flight workflows, then stopping');
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
      await embedder?.sink?.close();
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
