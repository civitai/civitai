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
