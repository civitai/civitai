/**
 * The minimal surface of the `@okikio/sharedworker` wrapper that teardown needs.
 *
 * The wrapper transparently backs onto a real `SharedWorker` when the browser
 * supports it, and falls back to a dedicated `Worker` when it does NOT (notably
 * Android Chrome / Samsung Internet, where `SharedWorker` is unavailable).
 *
 * ⚠️ The wrapper's type declares `get port(): MessagePort`, but at runtime on the
 * fallback path `port` is the dedicated `Worker` (which has `terminate()`, not
 * `close()`). That type-vs-runtime mismatch is exactly why calling
 * `worker.port.close()` typechecks yet throws `TypeError: port.close is not a
 * function` on the fallback cohort. Always use the wrapper's polymorphic
 * `close()` (below) instead of reaching into `.port`.
 */
export type TeardownableSignalWorker = {
  port?: {
    postMessage?: (message: unknown) => void;
    close?: () => void;
    terminate?: () => void;
  } | null;
  /** Wrapper method: closes the MessagePort (SharedWorker) or terminates the Worker (fallback). */
  close?: () => void;
  terminate?: () => void;
};

/**
 * Correctly tears down a signals worker across BOTH the `SharedWorker` and the
 * dedicated-`Worker` fallback paths.
 *
 * - Best-effort notifies the worker this tab is unloading (`beforeunload`).
 * - Then calls the wrapper's polymorphic `close()`, which closes this tab's
 *   MessagePort on SharedWorker-capable browsers and `terminate()`s the
 *   dedicated Worker on the fallback path — so the worker never leaks and the
 *   teardown never throws.
 * - Falls back to closing/terminating the raw port directly if the wrapper's
 *   `close()` is ever unavailable (defensive belt).
 *
 * Fixes the chronic `TypeError: port.close is not a function` that previously
 * fired on every unmount for the Android Chromium cohort (no SharedWorker),
 * where `worker.port` is the dedicated Worker (no `.close()`).
 */
export function teardownSignalWorker(worker: TeardownableSignalWorker | null | undefined) {
  if (!worker) return;

  // Best-effort: tell the (shared) worker this tab is going away. `postMessage`
  // exists on both a MessagePort and a dedicated Worker, so this is safe on both
  // paths; guard anyway in case the port is absent.
  try {
    worker.port?.postMessage?.({ type: 'beforeunload' });
  } catch {
    // ignore — teardown must not throw
  }

  // Preferred: the wrapper's polymorphic close() does the right thing per path.
  if (typeof worker.close === 'function') {
    worker.close();
    return;
  }
  if (typeof worker.terminate === 'function') {
    worker.terminate();
    return;
  }

  // Defensive belt: no wrapper close/terminate — tear down the raw port by
  // whichever method it actually supports (MessagePort → close, Worker → terminate).
  const port = worker.port;
  if (port && typeof port.close === 'function') port.close();
  else if (port && typeof port.terminate === 'function') port.terminate();
}

export class Deferred<T = void, E = unknown> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void = () => null;
  reject: (reason?: E) => void = () => null;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type CallbackFunction<T> = (args: T) => void;

type EventsDictionary<T extends Record<string, unknown>> = {
  [K in keyof T]: CallbackFunction<T[K]>[];
};

export class EventEmitter<T extends Record<string, unknown>> {
  callbacks: EventsDictionary<T>;

  constructor() {
    this.callbacks = {} as EventsDictionary<T>;
  }

  on<K extends keyof T>(event: K, cb: CallbackFunction<T[K]>) {
    if (!this.callbacks[event]) this.callbacks[event] = [];
    this.callbacks[event].push(cb);
    return () => this.off(event, cb);
  }

  off<K extends keyof T>(event: K, cb: CallbackFunction<T[K]>) {
    if (!this.callbacks[event]) return;
    const index = this.callbacks[event].indexOf(cb);
    this.callbacks[event].splice(index, 1);
  }

  emit<K extends keyof T>(event: K, args: T[K]) {
    const cbs = this.callbacks[event];
    if (cbs) cbs.forEach((cb) => cb(args));
  }

  stop() {
    this.callbacks = {} as EventsDictionary<T>;
  }
}

type OptionalIfUndefined<T> = undefined extends T ? [param?: T] : [param: T];

export const subscribable = <T>(args: T) => {
  const emitter = new EventEmitter<Record<'change', T>>();
  let data = args;

  const subscribe = (fn: (args: T) => void) => emitter.on('change', fn);

  const set = (args: T) => {
    data = args;
    emitter.emit('change', data);
  };

  const update = (fn: (state: T) => T) => {
    data = fn(data);
    emitter.emit('change', data);
  };

  return { subscribe, set, update };
};
