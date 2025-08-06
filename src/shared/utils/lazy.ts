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
