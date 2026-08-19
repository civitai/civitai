/**
 * A value that must not hold up the request that needs it — for an aggregate whose query has no index
 * of its own and whose caller would rather show nothing than wait.
 *
 * The race does NOT cancel the query: a timed-out call still holds its pool connection for its full
 * duration. Fine for a badge that runs once a minute behind a cache; not fine per-request.
 */
export const bounded = async <T>(run: () => Promise<T>, ms = 3_000): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
