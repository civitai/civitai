import { trace } from '@opentelemetry/api';
import { logToAxiom } from '~/server/logging/client';

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
/** Rows held while an insert is in flight; beyond this they are shed, never queued. */
export const MAX_BUFFERED_ROWS = 2_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export type CaptureConfig = {
  /** 0..1; 0 disables capture. */
  sampleRate: number;
  /** Epoch ms after which capture stops regardless of sampleRate. */
  until: number;
};

export const CAPTURE_OFF: CaptureConfig = { sampleRate: 0, until: 0 };

export function parseCaptureConfig(raw: Record<string, string> | null | undefined): CaptureConfig {
  const rate = Number(raw?.sampleRate ?? 0);
  const untilRaw = raw?.until?.trim();
  let until = Number.POSITIVE_INFINITY;
  if (untilRaw) until = /^\d+$/.test(untilRaw) ? Number(untilRaw) : Date.parse(untilRaw);
  return {
    sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0,
    // An `until` that does not parse disables capture rather than running unbounded.
    until: Number.isNaN(until) ? 0 : until,
  };
}

/** FNV-1a over the key, scaled to [0, 1): stable for a key across pods and restarts. */
export function hashToUnit(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

type Counter = { inc: (labels: { outcome: string }) => void };

export type SampledRowBufferDeps<Row> = {
  /** Names the table in the throttled failure log. */
  table: string;
  getConfig: () => Promise<CaptureConfig>;
  insert: (rows: Row[]) => Promise<void>;
  counters: { batches: Counter; rows: Counter };
  now?: () => number;
  random?: () => number;
  flushIntervalMs?: number;
  onError?: (error: Error, rows: number) => void;
};

export type SampledRowBuffer<Row> = {
  /**
   * Samples, then builds and buffers one row. `build` gets the time and the active OTEL traceId.
   * `unsampled` rows skip the rate roll but not the switch, `until` or the cap. A `sampleKey`
   * replaces the roll with a hash of the key, so every row sharing a key is kept or dropped together.
   * Never throws.
   */
  push: (
    build: (at: number, traceId: string) => Row,
    opts?: { unsampled?: boolean; sampleKey?: string }
  ) => Promise<void>;
  flush: () => Promise<void>;
  readonly pending: number;
  readonly dropped: number;
};

/** A sampled, capped buffer of ClickHouse rows, flushed by direct batched inserts. */
export function createSampledRowBuffer<Row>(
  deps: SampledRowBufferDeps<Row>
): SampledRowBuffer<Row> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  let buffer: Row[] = [];
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let lastErrorAt = 0;

  function reportFailure(e: Error, rows: number) {
    deps.counters.batches.inc({ outcome: 'failed' });
    if (deps.onError) return deps.onError(e, rows);
    if (now() - lastErrorAt <= ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now();
    logToAxiom(
      {
        type: 'error',
        name: `${deps.table} capture flush failed`,
        details: { rows },
        message: e.message,
      },
      'clickhouse'
    );
  }

  // One insert at a time: a slow ClickHouse holds one batch plus the bounded buffer,
  // not an unbounded set of in-flight requests.
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inflight || buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    inflight = deps
      .insert(rows)
      .then(
        () => deps.counters.batches.inc({ outcome: 'ok' }),
        (e) => reportFailure(e as Error, rows.length)
      )
      .finally(() => {
        inflight = null;
        if (buffer.length) scheduleFlush();
      });
    await inflight;
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function push(
    build: (at: number, traceId: string) => Row,
    { unsampled = false, sampleKey }: { unsampled?: boolean; sampleKey?: string } = {}
  ) {
    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
    const at = now();
    try {
      const config = await deps.getConfig();
      if (config.sampleRate <= 0 || at > config.until) return;
      const draw = sampleKey === undefined ? random() : hashToUnit(sampleKey);
      if (!unsampled && draw >= config.sampleRate) return;
      if (buffer.length >= MAX_BUFFERED_ROWS) {
        dropped++;
        deps.counters.rows.inc({ outcome: 'dropped' });
        return;
      }
      buffer.push(build(at, traceId));
      deps.counters.rows.inc({ outcome: 'buffered' });
      if (buffer.length >= FLUSH_AT_ROWS) void flush();
      else scheduleFlush();
    } catch {
      // Capture must never surface on the request path.
    }
  }

  return {
    push,
    flush,
    get pending() {
      return buffer.length;
    },
    get dropped() {
      return dropped;
    },
  };
}
