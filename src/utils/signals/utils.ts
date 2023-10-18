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
