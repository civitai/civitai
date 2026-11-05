import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { BACKSTOP_MS, DEFAULT_MAX_QUEUE } from './limits.ts';
import { fault } from './result.ts';
import type { EvaluateArgs, EvaluateOutput } from './sandbox.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

/** The pool's queue is full. Answered 503: a runner fault, so the caller says `hook_unavailable`. */
export class PoolOverloadedError extends Error {}
/** A worker died or failed to create an instance. Answered 500 (`hook_unavailable`). */
export class WorkerCrashedError extends Error {}
/** The pool is shutting down. */
export class PoolClosedError extends Error {}

export type PoolOptions = {
  size?: number;
  maxQueue?: number;
  /** Added to each call's timeoutMs to get the worker-terminate deadline. */
  backstopMs?: number;
  /** Called each time the backstop terminates a worker (the metric hook). */
  onBackstop?: () => void;
};

type Pending = {
  args: EvaluateArgs;
  resolve: (out: EvaluateOutput) => void;
  reject: (err: Error) => void;
};

type Slot = {
  worker: Worker;
  ready: boolean;
  busy: (Pending & { id: number; timer: NodeJS.Timeout; startedAt: number }) | null;
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
 * The backstop: a call still unanswered at `timeoutMs + backstopMs` (measured from dispatch to
 * the worker, so queue time is not charged to the hook) gets its worker TERMINATED and replaced,
 * and answers `timeout`. That covers a hook stuck in a native operation that never polls the
 * interrupt handler; see BACKSTOP_MS.
 */
export class HookPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly maxQueue: number;
  private readonly backstopMs: number;
  private readonly onBackstop: () => void;
  private nextId = 1;
  private closed = false;
  private terminatedCount = 0;

  private constructor(opts: PoolOptions) {
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.backstopMs = opts.backstopMs ?? BACKSTOP_MS;
    this.onBackstop = opts.onBackstop ?? (() => undefined);
  }

  static async start(opts: PoolOptions = {}): Promise<HookPool> {
    const pool = new HookPool(opts);
    const size = Math.max(1, opts.size ?? availableParallelism());
    await Promise.all(Array.from({ length: size }, () => pool.spawn()));
    return pool;
  }

  run(args: EvaluateArgs): Promise<EvaluateOutput> {
    if (this.closed) return Promise.reject(new PoolClosedError('pool is closed'));
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new PoolOverloadedError('hook queue is full'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
      this.pump();
    });
  }

  stats() {
    return {
      size: this.slots.length,
      ready: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
      terminated: this.terminatedCount,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new PoolClosedError('pool is closed'));
    await Promise.all(
      this.slots.map((s) => {
        if (s.busy) {
          clearTimeout(s.busy.timer);
          s.busy.reject(new PoolClosedError('pool is closed'));
          s.busy = null;
        }
        return s.worker.terminate();
      })
    );
  }

  private spawn(replacing?: Slot): Promise<void> {
    const worker = new Worker(WORKER_URL);
    const slot: Slot = { worker, ready: false, busy: null };
    if (replacing) this.slots[this.slots.indexOf(replacing)] = slot;
    else this.slots.push(slot);

    return new Promise<void>((resolveReady, rejectReady) => {
      worker.on('message', (msg: WorkerResponse) => {
        if ('ready' in msg) {
          slot.ready = true;
          resolveReady();
          this.pump();
          return;
        }
        const busy = slot.busy;
        if (!busy || busy.id !== msg.id) return; // a late answer after a backstop: ignore
        clearTimeout(busy.timer);
        slot.busy = null;
        if ('crashed' in msg) busy.reject(new WorkerCrashedError(msg.crashed));
        else busy.resolve({ result: msg.result, elapsedMs: msg.elapsedMs });
        this.pump();
      });
      const onDeath = (err?: Error) => {
        if (!this.slots.includes(slot)) return; // already replaced (backstop) or closing
        if (!slot.ready) {
          // Died before it could serve: respawning would loop forever on a broken image (for
          // example a missing .wasm). Leave the slot dead; /readyz reports a pool with no ready
          // worker.
          rejectReady(err ?? new WorkerCrashedError('worker exited during start'));
          return;
        }
        slot.ready = false;
        const busy = slot.busy;
        slot.busy = null;
        if (busy) {
          clearTimeout(busy.timer);
          busy.reject(new WorkerCrashedError(err ? err.message : 'worker exited'));
        }
        if (!this.closed) void this.spawn(slot).catch(() => undefined);
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
      const next = this.queue.shift();
      if (!next) return;
      const id = this.nextId++;
      const startedAt = performance.now();
      const timer = setTimeout(
        () => this.backstop(slot, id),
        next.args.timeoutMs + this.backstopMs
      );
      slot.busy = { ...next, id, timer, startedAt };
      const req: WorkerRequest = { id, ...next.args };
      slot.worker.postMessage(req);
    }
  }

  private backstop(slot: Slot, id: number): void {
    const busy = slot.busy;
    if (!busy || busy.id !== id) return;
    slot.busy = null;
    this.terminatedCount++;
    this.onBackstop();
    // Replace first, so the dead worker's 'exit' finds the slot already gone.
    const old = slot.worker;
    void this.spawn(slot).catch(() => undefined);
    void old.terminate();
    busy.resolve({
      result: fault('timeout', 'terminated by the worker backstop'),
      elapsedMs: performance.now() - busy.startedAt,
    });
  }
}
