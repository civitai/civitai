/**
 * App Blocks custom-events beacon (client half of `POST /api/track/block-event`).
 *
 * Unlike `bridgeMessageBeacon.ts`, which sums counts, this queues one ROW per `track()` call:
 * the server checks every row against the app's approved manifest, so rows cannot be merged.
 *
 * Identity (`appBlockId`, `blockInstanceId`) is supplied by the host from its own props; the
 * block's payload contributes only `eventName` and `properties`. Property values are forwarded as
 * given: the server classifies them, so an author's wrongly typed value is counted there.
 *
 * Fire-and-forget: never throws to the host; failed POSTs are not retried; nothing dropped on the
 * client is counted.
 */

export type BlockEventIdentity = { appBlockId: string; blockInstanceId: string };

export type BlockEventRow = BlockEventIdentity & {
  eventName: string;
  properties?: Record<string, unknown>;
};

const ENDPOINT = '/api/track/block-event';

export const BLOCK_EVENT_FLUSH_INTERVAL_MS = 10_000;
/** The ingest schema's `BLOCK_EVENT_BATCH_MAX`; the contract test pins the two together. */
export const BLOCK_EVENT_BATCH_ROWS = 50;
/**
 * Half the route's 64 kb body limit: the browser's keepalive quota (about 64 KiB in flight per
 * document) is shared with the other beacons flushing on the same `pagehide`. For the same reason
 * a page-exit flush sends one body at most.
 */
export const BLOCK_EVENT_MAX_BODY_BYTES = 32 * 1024;
export const BLOCK_EVENT_RATE_PER_SECOND = 10;
export const BLOCK_EVENT_CAP_PER_MOUNT = 500;

/**
 * A row's serialised form, measured once when it is recorded. Only the string is kept: holding the
 * row would keep the block's `properties` object (which may hold a large buffer) alive until flush.
 */
type QueuedRow = { json: string; bytes: number };

const queue: QueuedRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

const BODY_PREFIX = '{"events":[';
const BODY_SUFFIX = ']}';
const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

function byteLength(s: string): number {
  return encoder ? encoder.encode(s).length : s.length * 3;
}

const FRAME_BYTES = byteLength(BODY_PREFIX) + byteLength(BODY_SUFFIX);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') flushBlockEvents({ pageExit: true });
}

function onPageHide() {
  flushBlockEvents({ pageExit: true });
}

function bindLifecycleListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
}

function post(body: string): void {
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    ) {
      return;
    }
  } catch {}
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => undefined);
  } catch {
    // dropped: telemetry must not reach the host
  }
}

/**
 * Split rows into request bodies of at most {@link BLOCK_EVENT_MAX_BODY_BYTES} UTF-8 bytes. The
 * queue never holds more than {@link BLOCK_EVENT_BATCH_ROWS} rows, and the recorder rejects a row
 * that cannot fit in a body on its own.
 */
function buildBodies(rows: QueuedRow[]): string[] {
  const bodies: string[] = [];
  let current: string[] = [];
  let currentBytes = FRAME_BYTES;
  for (const { json, bytes } of rows) {
    const separator = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentBytes + separator + bytes > BLOCK_EVENT_MAX_BODY_BYTES) {
      bodies.push(BODY_PREFIX + current.join(',') + BODY_SUFFIX);
      current = [];
      currentBytes = FRAME_BYTES;
    }
    currentBytes += (current.length > 0 ? 1 : 0) + bytes;
    current.push(json);
  }
  if (current.length > 0) bodies.push(BODY_PREFIX + current.join(',') + BODY_SUFFIX);
  return bodies;
}

export function flushBlockEvents(options: { pageExit?: boolean } = {}): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const bodies = buildBodies(queue.splice(0));
  for (const body of options.pageExit ? bodies.slice(0, 1) : bodies) post(body);
}

function enqueue(entry: QueuedRow): void {
  bindLifecycleListeners();
  queue.push(entry);
  if (queue.length >= BLOCK_EVENT_BATCH_ROWS) {
    flushBlockEvents();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      flushBlockEvents();
    }, BLOCK_EVENT_FLUSH_INTERVAL_MS);
  }
}

/**
 * The recorder for ONE host mount. Its budget ({@link BLOCK_EVENT_RATE_PER_SECOND} events a
 * second, {@link BLOCK_EVENT_CAP_PER_MOUNT} in all) belongs to that mount, so a new page or app
 * starts fresh and two mounts of one app do not share it; it is released with the mount.
 * Every well-shaped event spends budget BEFORE it is serialised, including one later dropped as
 * oversize or unserialisable, so the budget also bounds the serialisation work a block can cause.
 * Malformed, oversize and over-budget events are dropped.
 */
export function createBlockEventRecorder(identity: BlockEventIdentity): (payload: unknown) => void {
  let spent = 0;
  let recent: number[] = [];
  return (payload) => {
    if (typeof window === 'undefined') return;
    if (!isPlainObject(payload) || typeof payload.eventName !== 'string') return;
    if (spent >= BLOCK_EVENT_CAP_PER_MOUNT) return;
    const now = Date.now();
    recent = recent.filter((t) => now - t < 1000);
    if (recent.length >= BLOCK_EVENT_RATE_PER_SECOND) return;
    spent += 1;
    recent.push(now);

    const row: BlockEventRow = {
      appBlockId: identity.appBlockId,
      blockInstanceId: identity.blockInstanceId,
      eventName: payload.eventName,
      ...(isPlainObject(payload.properties) ? { properties: payload.properties } : {}),
    };
    let json: string;
    try {
      // A structured-cloned payload can hold a BigInt or a cycle, which JSON cannot.
      json = JSON.stringify(row);
    } catch {
      return;
    }
    const bytes = byteLength(json);
    if (FRAME_BYTES + bytes > BLOCK_EVENT_MAX_BODY_BYTES) return;

    enqueue({ json, bytes });
  };
}

export const _internalsForTests = {
  reset(): void {
    queue.length = 0;
    if (listenersBound) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      listenersBound = false;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  },
  queued(): BlockEventRow[] {
    return queue.map(({ json }) => JSON.parse(json) as BlockEventRow);
  },
  entryKeys(): string[][] {
    return queue.map((entry) => Object.keys(entry));
  },
  timerArmed(): boolean {
    return timer !== null;
  },
};
