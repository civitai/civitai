/** node-redis's own connection state, read off a built client. */
export type RedisClientState = { isOpen?: boolean; isReady?: boolean };

/**
 * How long a client may stay unusable before the pod reports not-ready. Longer than a self-heal
 * reconnect or a failover takes, so those don't pull every pod out of rotation at once.
 */
export const REDIS_READINESS_GRACE_MS = 30_000;

/**
 * Readiness over the hub's Redis clients: not ready once any built client has been closed or not
 * ready on every check for at least `graceMs`. The clock starts at the first check that sees it
 * unusable and resets on the first check that sees it usable again. A client that was never built
 * (or isn't configured) is ignored.
 */
export function createRedisReadiness({
  clients,
  graceMs = REDIS_READINESS_GRACE_MS,
  now = () => Date.now(),
}: {
  clients: () => Record<string, RedisClientState | null>;
  graceMs?: number;
  now?: () => number;
}) {
  const unusableSince = new Map<string, number>();
  return {
    check(): { ready: boolean; unusable: string[] } {
      const t = now();
      const unusable: string[] = [];
      for (const [name, client] of Object.entries(clients())) {
        if (!client || (client.isOpen !== false && client.isReady !== false)) {
          unusableSince.delete(name);
          continue;
        }
        const since = unusableSince.get(name) ?? t;
        unusableSince.set(name, since);
        if (t - since >= graceMs) unusable.push(name);
      }
      return { ready: unusable.length === 0, unusable };
    },
  };
}
