/** A Redis client that is offline can queue a command and never settle it, so every call is raced against a clock. */
export const REDIS_TIMEOUT_MS = 400;

export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`store did not answer in ${ms}ms`)), ms);
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}
