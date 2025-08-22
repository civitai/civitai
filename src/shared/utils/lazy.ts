export function lazy<T>(fn: () => T): () => T {
  let cache: T | undefined;
  let initialized = false;

  return () => {
    if (!initialized) {
      cache = fn();
      initialized = true;
    }
    return cache!;
  };
}

/**
 * Creates a lazily-initialized object/function-like value.
 *
 * The initializer runs only once (on first access/call), and the
 * returned proxy behaves like the real initialized object.
 */
export function lazyProxy<T extends object>(initializer: () => T): T {
  let instance: T | null = null;

  function init(): T {
    if (!instance) {
      instance = initializer();
    }
    return instance;
  }

  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      return Reflect.get(init(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(init(), prop, value, receiver);
    },
    apply(_target, thisArg, args) {
      return Reflect.apply(init() as any, thisArg, args);
    },
    construct(_target, args, newTarget) {
      return Reflect.construct(init() as any, args, newTarget);
    },
    has(_target, prop) {
      return prop in init();
    },
  });
}
