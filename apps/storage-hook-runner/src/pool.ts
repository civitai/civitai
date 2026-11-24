import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import {
  BACKSTOP_MS,
  DEFAULT_MAX_QUEUE,
  DEAD_AFTER_MS,
  RESPAWN_BASE_MS,
  RESPAWN_MAX_MS,
  REMIX_MAX_QUEUE_WAIT_MS,
  defaultMaxPerApp,
} from './limits.ts';
import type { RemixArgs, RemixOutput } from './remix.ts';
import type { EvaluateArgs, EvaluateOutput } from './sandbox.ts';
import type { WorkerJob, WorkerRequest, WorkerResponse } from './worker.ts';

/** The pool's queue, or this app's share of it, is full. Answered 503 (`hook_unavailable`). */
export class PoolOverloadedError extends Error {
  readonly scope: 'queue' | 'app';
  constructor(scope: 'queue' | 'app') {
    super(scope === 'queue' ? 'hook queue is full' : 'this app has too many hook calls in flight');
    this.scope = scope;
  }
}
/** A worker died or could not evaluate. Answered 500 (`hook_unavailable`). */
export class WorkerCrashedError extends Error {}
/**
 * The backstop terminated the call's worker. For a hook, a RUNNER fault answered 500: the in-VM
 * interrupt is what bounds a hook's time, and the backstop firing means it did not (native work
 * that never polled it, or a worker starved of CPU), so the author is not blamed with `timeout`.
 * A remix call answers 423 `quarantined` instead (see app.ts).
 */
export class BackstopError extends Error {}
/** The pool is shutting down. */
export class PoolClosedError extends Error {}

export type RunArgs = EvaluateArgs & {
  /** The app's blockId: the per-app fairness key and the metric label. */
  appId: string;
};

export type RemixRunArgs = RemixArgs & {
  appId: string;
  /** The call's time before the backstop's margin: the sum of its replays' budgets. */
  budgetMs: number;
};

type Answer = Exclude<WorkerResponse, { ready: true } | { crashed: string }>;

export type PoolOptions = {
  size?: number;
  maxQueue?: number;
  /** Calls one app may have queued plus in flight. Default ⌈maxQueue / 4⌉. */
  maxPerApp?: number;
  /** Added to each call's budget (a hook's timeoutMs) to get the worker-terminate deadline. */
  backstopMs?: number;
  /** Called each time the backstop terminates a worker (the metric hook). */
  onBackstop?: (appId: string) => void;
  /** First retry delay for a replacement worker that failed to start; doubles to RESPAWN_MAX_MS. */
  respawnBaseMs?: number;
  /** `liveness()` reports not live once no worker has been ready for this long. */
  deadAfterMs?: number;
  /** Test seam: how a worker is created. */
  createWorker?: (url: URL) => Worker;
  /** See REMIX_MAX_QUEUE_WAIT_MS. */
  remixQueueWaitMs?: number;
};

type Pending = {
  appId: string;
  budgetMs: number;
  job: WorkerJob;
  enqueuedAt: number;
  resolve: (out: Answer) => void;
  reject: (err: Error) => void;
};

type Slot = {
  worker: Worker;
  ready: boolean;
  busy: (Pending & { id: number; timer: NodeJS.Timeout }) | null;
};

// Under vitest this module is TypeScript source and the worker is loaded by Node's own type
// stripping; in the image both are tsup output side by side in dist/.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url
);

/**
 * A fixed set of worker_threads, one evaluation each at a time, plus a bounded FIFO queue.
 *
 * Fairness: one app may hold at most `maxPerApp` calls (queued plus in flight); past that, that
 * app gets PoolOverloadedError('app') while other apps are still admitted.
 *
 * The backstop: a call still unanswered at its budget (a hook's `timeoutMs`, a remix call's
 * `budgetMs`) plus `backstopMs`, measured from dispatch to the worker so queue time is not
 * charged to the hook, gets its worker TERMINATED and replaced, and rejects with BackstopError.
 * See BACKSTOP_MS.
 *
 * Replacement: a worker that dies after it was serving is replaced at once. A replacement that
 * fails to start is retried with exponential backoff (respawnBaseMs doubling to RESPAWN_MAX_MS),
 * forever: a transient failure must not leave the pod with fewer workers. A worker that fails
 * during the INITIAL start fails `start()` instead, so a broken image fails at boot.
 */
export class HookPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly perApp = new Map<string, number>();
  private readonly maxQueue: number;
  private readonly maxPerApp: number;
  private readonly backstopMs: number;
  private readonly remixQueueWaitMs: number;
  private readonly respawnBaseMs: number;
  private readonly deadAfterMs: number;
  private readonly onBackstop: (appId: string) => void;
  private readonly createWorker: (url: URL) => Worker;
  private readonly respawnTimers = new Set<NodeJS.Timeout>();
  private nextId = 1;
  private closed = false;
  private terminatedCount = 0;
  private restartCount = 0;
  /** When the ready-worker count last dropped to zero; null while at least one is ready. */
  private zeroReadySince: number | null = null;

  private constructor(opts: PoolOptions) {
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.maxPerApp = opts.maxPerApp ?? defaultMaxPerApp(this.maxQueue);
    this.backstopMs = opts.backstopMs ?? BACKSTOP_MS;
    this.remixQueueWaitMs = opts.remixQueueWaitMs ?? REMIX_MAX_QUEUE_WAIT_MS;
    this.respawnBaseMs = opts.respawnBaseMs ?? RESPAWN_BASE_MS;
    this.deadAfterMs = opts.deadAfterMs ?? DEAD_AFTER_MS;
    this.onBackstop = opts.onBackstop ?? (() => undefined);
    this.createWorker = opts.createWorker ?? ((url) => new Worker(url));
  }

  static async start(opts: PoolOptions = {}): Promise<HookPool> {
    const pool = new HookPool(opts);
    const size = Math.max(1, opts.size ?? availableParallelism());
    for (let i = 0; i < size; i++) pool.slots.push(pool.newSlot());
    try {
      await Promise.all(pool.slots.map((_, i) => pool.spawnInto(i, null)));
    } catch (err) {
      await pool.close();
      throw err;
    }
    return pool;
  }

  async run({ appId, ...args }: RunArgs): Promise<EvaluateOutput> {
    const out = await this.enqueue(appId, args.timeoutMs, { kind: 'hook', ...args });
    if (!('result' in out)) throw new WorkerCrashedError('worker answered a remix call');
    return { result: out.result, elapsedMs: out.elapsedMs };
  }

  async runRemix({ appId, budgetMs, ...args }: RemixRunArgs): Promise<RemixOutput> {
    const out = await this.enqueue(appId, budgetMs, { kind: 'remix', ...args });
    if (!('remix' in out)) throw new WorkerCrashedError('worker answered a hook call');
    return out.remix;
  }

  private enqueue(appId: string, budgetMs: number, job: WorkerJob): Promise<Answer> {
    if (this.closed) return Promise.reject(new PoolClosedError('pool is closed'));
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new PoolOverloadedError('queue'));
    }
    const held = this.perApp.get(appId) ?? 0;
    if (held >= this.maxPerApp) return Promise.reject(new PoolOverloadedError('app'));
    this.perApp.set(appId, held + 1);
    const release = () => {
      const n = (this.perApp.get(appId) ?? 1) - 1;
      if (n <= 0) this.perApp.delete(appId);
      else this.perApp.set(appId, n);
    };
    return new Promise((resolve, reject) => {
      this.queue.push({
        appId,
        budgetMs,
        job,
        enqueuedAt: performance.now(),
        resolve: (out) => {
          release();
          resolve(out);
        },
        reject: (err) => {
          release();
          reject(err);
        },
      });
      this.pump();
    });
  }

  stats() {
    return {
      size: this.slots.length,
      ready: this.readyCount(),
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
      terminated: this.terminatedCount,
      /** Replacement workers spawned (after a death, a backstop, or a failed start). */
      restarts: this.restartCount,
      maxPerApp: this.maxPerApp,
    };
  }

  /** Not live once no worker has been ready for `deadAfterMs`: /healthz fails, the pod restarts. */
  liveness(): { live: boolean; ready: number } {
    const ready = this.readyCount();
    const live =
      ready > 0 ||
      this.zeroReadySince === null ||
      performance.now() - this.zeroReadySince < this.deadAfterMs;
    return { live, ready };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.respawnTimers) clearTimeout(t);
    this.respawnTimers.clear();
    for (const p of this.queue.splice(0)) p.reject(new PoolClosedError('pool is closed'));
    await Promise.all(
      this.slots.map((s) => {
        s.ready = false;
        if (s.busy) {
          clearTimeout(s.busy.timer);
          s.busy.reject(new PoolClosedError('pool is closed'));
          s.busy = null;
        }
        return s.worker.terminate();
      })
    );
  }

  private readyCount(): number {
    return this.slots.filter((s) => s.ready).length;
  }

  private noteReadyChange(): void {
    if (this.readyCount() > 0) this.zeroReadySince = null;
    else this.zeroReadySince ??= performance.now();
  }

  private newSlot(): Slot {
    // A placeholder until spawnInto installs a real worker.
    return { worker: null as unknown as Worker, ready: false, busy: null };
  }

  /**
   * Start a worker in slot `index`. `attempt` is null for the initial start (a failure rejects,
   * failing `start()`), else the replacement attempt number (a failure retries with backoff).
   */
  private spawnInto(index: number, attempt: number | null): Promise<void> {
    if (attempt !== null) this.restartCount++;
    const worker = this.createWorker(WORKER_URL);
    const slot: Slot = { worker, ready: false, busy: null };
    this.slots[index] = slot;

    return new Promise<void>((resolveReady, rejectReady) => {
      worker.on('message', (msg: WorkerResponse) => {
        if ('ready' in msg) {
          slot.ready = true;
          this.noteReadyChange();
          resolveReady();
          this.pump();
          return;
        }
        const busy = slot.busy;
        if (!busy || busy.id !== msg.id) return; // a late answer after a backstop: ignore
        clearTimeout(busy.timer);
        slot.busy = null;
        if ('crashed' in msg) busy.reject(new WorkerCrashedError(msg.crashed));
        else busy.resolve(msg);
        this.pump();
      });
      let dead = false;
      const onDeath = (err?: Error) => {
        if (dead) return;
        dead = true;
        if (this.slots[index] !== slot || this.closed) return; // replaced (backstop) or closing
        const wasReady = slot.ready;
        slot.ready = false;
        this.noteReadyChange();
        const busy = slot.busy;
        slot.busy = null;
        if (busy) {
          clearTimeout(busy.timer);
          busy.reject(new WorkerCrashedError(err ? err.message : 'worker exited'));
        }
        if (!wasReady) {
          rejectReady(err ?? new WorkerCrashedError('worker exited during start'));
          if (attempt === null) return; // initial start: start() fails
          const delay = Math.min(this.respawnBaseMs * 2 ** attempt, RESPAWN_MAX_MS);
          const t = setTimeout(() => {
            this.respawnTimers.delete(t);
            if (!this.closed) void this.spawnInto(index, attempt + 1).catch(() => undefined);
          }, delay);
          this.respawnTimers.add(t);
          return;
        }
        void this.spawnInto(index, 0).catch(() => undefined);
      };
      worker.on('error', (err) => onDeath(err));
      worker.on('exit', () => onDeath());
    });
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (!slot.ready || slot.busy) continue;
      const next = this.nextFresh();
      if (!next) return;
      const id = this.nextId++;
      const timer = setTimeout(() => this.backstop(slot, id), next.budgetMs + this.backstopMs);
      slot.busy = { ...next, id, timer };
      slot.worker.postMessage({ id, ...next.job } satisfies WorkerRequest);
    }
  }

  /** The next queued call, refusing each remix call that waited past REMIX_MAX_QUEUE_WAIT_MS. */
  private nextFresh(): Pending | undefined {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      if (next.job.kind !== 'remix' || performance.now() - next.enqueuedAt <= this.remixQueueWaitMs)
        return next;
      next.reject(new PoolOverloadedError('queue'));
    }
    return undefined;
  }

  private backstop(slot: Slot, id: number): void {
    const busy = slot.busy;
    if (!busy || busy.id !== id) return;
    const index = this.slots.indexOf(slot);
    slot.busy = null;
    slot.ready = false;
    this.terminatedCount++;
    this.onBackstop(busy.appId);
    // Replace first, so the dead worker's 'exit' finds the slot already taken.
    const old = slot.worker;
    if (index !== -1 && !this.closed) void this.spawnInto(index, 0).catch(() => undefined);
    this.noteReadyChange();
    void old.terminate();
    busy.reject(new BackstopError('terminated by the worker backstop'));
  }
}
