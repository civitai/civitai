/**
 * The event cosmetic reads one request shares. Two settings-bootstrap members read the viewer's
 * event cosmetic in the same `Promise.all` (the nav banners' joined cta and the event seeds); on a
 * cache miss each would read the database and write the same cache entry. The bootstrap makes one
 * of these per request and hands it to both, so the first read is the only one.
 *
 * Never shared across requests: a request-scoped map only, so nothing outlives the render.
 */
export type EventCosmeticReads = Map<string, Promise<unknown>>;

/**
 * How long a bootstrap member waits on the viewer's event cosmetic before going on without it. The
 * bootstrap is on every server render's critical path, so a slow read (a cache miss) must not hold
 * the page; each member's fallback leaves the answer to the client, as before the seed existed.
 */
export const EVENT_COSMETIC_READ_DEADLINE_MS = 300;

/** `read()` once per (user, event) within `reads`; with no `reads`, just `read()`. */
export function readEventCosmeticOnce<T>(
  reads: EventCosmeticReads | undefined,
  { event, userId }: { event: string; userId: number },
  read: () => Promise<T>
): Promise<T> {
  if (!reads) return read();
  const key = `${userId}:${event}`;
  let pending = reads.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read();
    reads.set(key, pending);
  }
  return pending;
}
