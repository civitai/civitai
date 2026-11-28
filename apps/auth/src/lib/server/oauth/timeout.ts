/**
 * `op`, or a rejection with `message` once `ms` passes first. The timer is cleared either way. It does not
 * cancel `op`: a late result is dropped.
 */
export async function raceTimeout<T>(op: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
