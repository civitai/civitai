const READY_POLL_MS = 20;

/**
 * Wait up to `ms` for a redis client to be ready. The sys client rejects commands until then (at startup, and
 * while reconnecting) instead of queueing them. A client that does not report `isReady` counts as ready.
 * Resolves false when the client is not ready in time.
 */
export async function waitForRedisReady(
  client: { isReady?: boolean },
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (client.isReady === false) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(READY_POLL_MS, left)));
  }
  return true;
}
