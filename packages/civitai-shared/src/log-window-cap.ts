export type LogWindowSummary = {
  /** Records counted instead of written. */
  dropped: number;
  /** Dropped records per key (the audited action, for example), so the target stays visible. */
  byKey: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  /** Distinct client IPs among the dropped records, at most `maxIps`. */
  clientIps: string[];
};

/**
 * Per-process cap on a flood of log records. The first `limit` records in each window are written in
 * full; the rest are counted, and the count is handed to `onSummary` when the window ends, even if
 * nothing more arrives. A summary still pending when the process exits is lost.
 */
export function createLogWindowCap(options: {
  limit: number;
  windowMs: number;
  maxIps?: number;
  onSummary: (summary: LogWindowSummary) => void;
}) {
  const { limit, windowMs, maxIps = 20, onSummary } = options;
  // Monotonic, so a wall-clock step cannot stretch or repeat a window.
  let windowEnd = -Infinity;
  let written = 0;
  let pending: LogWindowSummary | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const summary = pending;
    pending = undefined;
    try {
      onSummary(summary);
    } catch {
      /* a summary write must never throw from a timer */
    }
  }

  return {
    /** True: write this record in full. False: it was counted into this window's summary. */
    admit(record: { key: string; clientIp?: string | null }): boolean {
      const now = performance.now();
      if (now >= windowEnd) {
        flush();
        windowEnd = now + windowMs;
        written = 0;
      }
      if (written < limit) {
        written++;
        return true;
      }

      const seen = new Date().toISOString();
      if (!pending) {
        pending = { dropped: 0, byKey: {}, firstSeen: seen, lastSeen: seen, clientIps: [] };
        timer = setTimeout(flush, windowEnd - now);
        // Never hold a process open just to write a count.
        (timer as { unref?: () => void }).unref?.();
      }
      pending.dropped++;
      pending.byKey[record.key] = (pending.byKey[record.key] ?? 0) + 1;
      pending.lastSeen = seen;
      const ip = record.clientIp;
      if (ip && pending.clientIps.length < maxIps && !pending.clientIps.includes(ip))
        pending.clientIps.push(ip);
      return false;
    },
  };
}
