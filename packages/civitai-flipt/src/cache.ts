// TTL cache with generational rotation instead of full-clear eviction. On overflow the current
// generation becomes the "previous" one (the old previous is dropped) and a fresh generation
// starts, so hot keys survive at least one rotation and we never thrash to worse-than-no-cache
// under high key cardinality. Single-threaded, so Map ops need no locking.
//
// Steady-state live entries are bounded to ~2x maxEntries; a burst of distinct promoting reads
// with no intervening insert can transiently reach ~4x before the next insert rotates — still
// bounded, and entries are tiny.

type Entry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  private current = new Map<string, Entry<T>>();
  private previous = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, now: number): { hit: boolean; value?: T } {
    const cur = this.current.get(key);
    if (cur) {
      if (cur.expiresAt > now) return { hit: true, value: cur.value };
      this.current.delete(key);
    }
    const prev = this.previous.get(key);
    if (prev) {
      if (prev.expiresAt > now) {
        // Promote into the current generation so hot keys aren't lost on rotate.
        this.previous.delete(key);
        this.current.set(key, prev);
        return { hit: true, value: prev.value };
      }
      this.previous.delete(key);
    }
    return { hit: false };
  }

  set(key: string, value: T, now: number): void {
    if (this.ttlMs === 0) return;
    if (this.current.size >= this.maxEntries) {
      this.previous = this.current;
      this.current = new Map();
    }
    this.current.set(key, { value, expiresAt: now + this.ttlMs });
  }
}

// Build a collision-proof cache key. Components are URI-encoded so that a `|`, `&`, or `=` inside
// an entityId or context value can't alias another key.
export function fliptCacheKey(
  flag: string,
  entityId: string,
  context: Record<string, string>
): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return `${flag}|${encodeURIComponent(entityId)}`;
  const ctx = keys
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(context[k])}`)
    .join('&');
  return `${flag}|${encodeURIComponent(entityId)}|${ctx}`;
}
