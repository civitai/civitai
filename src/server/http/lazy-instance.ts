/**
 * A stand-in for an object that is built on first use rather than at import. For HTTP callers
 * whose constructor throws without its env: importing the module stays safe (the build loads it
 * while collecting page data), and the first call throws the same error the import used to.
 */
export function lazyInstance<T extends object>(create: () => T): T {
  return new Proxy({} as T, {
    get(_, key) {
      const instance = create();
      const value = Reflect.get(instance, key, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}
