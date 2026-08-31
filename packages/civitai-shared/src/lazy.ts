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
 * Creates a lazily-initialized object or callable function.
 * - If the initializer returns a function, the returned proxy is callable.
 * - Property access and function calls trigger lazy initialization.
 */
export function lazyProxy<T extends Record<string | symbol, any> | ((...args: any) => any)>(
  initializer: () => T
): T {
  let instance: T | null = null;

  function init(): T {
    if (!instance) {
      instance = initializer();
    }
    return instance;
  }

  const isFunction = () => typeof init() === 'function';

  return new Proxy(() => undefined as any, {
    get(_target, prop, receiver) {
      return Reflect.get(init(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(init(), prop, value, receiver);
    },
    has(_target, prop) {
      return prop in init();
    },
    apply(_target, thisArg, args) {
      if (!isFunction()) {
        throw new TypeError('Target is not callable');
      }
      return (init() as any).apply(thisArg, args);
    },
    construct(_target, args, newTarget) {
      if (!isFunction()) {
        throw new TypeError('Target is not constructible');
      }
      return Reflect.construct(init() as any, args, newTarget);
    },
  }) as T;
}
