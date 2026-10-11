/**
 * App Blocks custom-events beacon (client half of `POST /api/track/block-event`).
 *
 * Unlike `bridgeMessageBeacon.ts`, which sums counts, this queues one ROW per `track()` call:
 * the server checks every row against the app's approved manifest, so rows cannot be merged.
 *
 * Identity (`appBlockId`, `blockInstanceId`) is supplied by the host from its own props; the
 * block's payload contributes only `eventName` and `properties`.
 *
 * Fire-and-forget: never throws to the host; failed POSTs are not retried.
 */

export type BlockEventIdentity = { appBlockId: string; blockInstanceId: string };

type PropertyValue = string | number | boolean | null;

export type BlockEventRow = BlockEventIdentity & {
  eventName: string;
  properties?: Record<string, PropertyValue>;
};

const ENDPOINT = '/api/track/block-event';

export const BLOCK_EVENT_FLUSH_INTERVAL_MS = 10_000;
/** The ingest schema's `BLOCK_EVENT_BATCH_MAX`; the contract test pins the two together. */
export const BLOCK_EVENT_BATCH_ROWS = 50;
/**
 * Half the route's 64 kb body limit: the browser's keepalive quota (about 64 KiB in flight per
 * document) is shared with the other beacons flushing on the same `pagehide`.
 */
export const BLOCK_EVENT_MAX_BODY_BYTES = 32 * 1024;
export const BLOCK_EVENT_RATE_PER_INSTANCE_PER_SECOND = 10;
/** Per app, so one chatty app cannot use up the budget of the other apps on the page. */
export const BLOCK_EVENT_SESSION_CAP_PER_APP = 500;

type DropReason = 'invalid' | 'rate_limited' | 'session_cap' | 'oversize';

const queue: BlockEventRow[] = [];
const recentByInstance = new Map<string, number[]>();
const dropped: Record<DropReason, number> = {
  invalid: 0,
  rate_limited: 0,
  session_cap: 0,
  oversize: 0,
};
const acceptedByApp = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

const BODY_PREFIX = '{"events":[';
const BODY_SUFFIX = ']}';
const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

function byteLength(s: string): number {
  return encoder ? encoder.encode(s).length : s.length * 3;
}

const FRAME_BYTES = byteLength(BODY_PREFIX) + byteLength(BODY_SUFFIX);

function fitsInOneBody(rowBytes: number): boolean {
  return FRAME_BYTES + rowBytes <= BLOCK_EVENT_MAX_BODY_BYTES;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveProperties(raw: unknown): Record<string, PropertyValue> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, PropertyValue> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
    }
  }
  return out;
}

function withinRate(instanceKey: string, now: number): boolean {
  const recent = (recentByInstance.get(instanceKey) ?? []).filter((t) => now - t < 1000);
  if (recent.length >= BLOCK_EVENT_RATE_PER_INSTANCE_PER_SECOND) {
    recentByInstance.set(instanceKey, recent);
    return false;
  }
  recent.push(now);
  recentByInstance.set(instanceKey, recent);
  return true;
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') flushBlockEvents();
}

function onPageHide() {
  flushBlockEvents();
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
 * Split rows into request bodies of at most {@link BLOCK_EVENT_BATCH_ROWS} rows and
 * {@link BLOCK_EVENT_MAX_BODY_BYTES} UTF-8 bytes. A row too large to fit in a body on its own is
 * dropped and counted in `oversize`.
 */
export function buildBlockEventBodies(rows: BlockEventRow[]): {
  bodies: string[];
  oversize: number;
} {
  const bodies: string[] = [];
  let oversize = 0;
  let current: string[] = [];
  let currentBytes = FRAME_BYTES;
  const close = () => {
    if (current.length === 0) return;
    bodies.push(BODY_PREFIX + current.join(',') + BODY_SUFFIX);
    current = [];
    currentBytes = FRAME_BYTES;
  };
  for (const row of rows) {
    const json = JSON.stringify(row);
    const rowBytes = byteLength(json);
    if (!fitsInOneBody(rowBytes)) {
      oversize += 1;
      continue;
    }
    const separator = current.length > 0 ? 1 : 0;
    if (
      current.length >= BLOCK_EVENT_BATCH_ROWS ||
      currentBytes + separator + rowBytes > BLOCK_EVENT_MAX_BODY_BYTES
    ) {
      close();
    }
    currentBytes += (current.length > 0 ? 1 : 0) + rowBytes;
    current.push(json);
  }
  close();
  return { bodies, oversize };
}

export function flushBlockEvents(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const { bodies, oversize } = buildBlockEventBodies(queue.splice(0));
  dropped.oversize += oversize;
  for (const body of bodies) post(body);
}

/**
 * Queue one `TRACK_EVENT` payload under the host's identity; malformed, oversize, over-rate and
 * over-cap payloads are dropped.
 */
export function recordBlockEvent(identity: BlockEventIdentity, payload: unknown): void {
  if (typeof window === 'undefined') return;
  if (!isPlainObject(payload) || typeof payload.eventName !== 'string') {
    dropped.invalid += 1;
    return;
  }
  const accepted = acceptedByApp.get(identity.appBlockId) ?? 0;
  if (accepted >= BLOCK_EVENT_SESSION_CAP_PER_APP) {
    dropped.session_cap += 1;
    return;
  }
  const properties = primitiveProperties(payload.properties);
  const row: BlockEventRow = {
    appBlockId: identity.appBlockId,
    blockInstanceId: identity.blockInstanceId,
    eventName: payload.eventName,
    ...(properties ? { properties } : {}),
  };
  // Measured here as well as at flush, so an oversize row is never held in the queue.
  if (!fitsInOneBody(byteLength(JSON.stringify(row)))) {
    dropped.oversize += 1;
    return;
  }
  const instanceKey = `${identity.appBlockId}\u0000${identity.blockInstanceId}`;
  if (!withinRate(instanceKey, Date.now())) {
    dropped.rate_limited += 1;
    return;
  }
  acceptedByApp.set(identity.appBlockId, accepted + 1);
  bindLifecycleListeners();
  queue.push(row);
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

export const _internalsForTests = {
  reset(): void {
    queue.length = 0;
    recentByInstance.clear();
    acceptedByApp.clear();
    if (listenersBound) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      listenersBound = false;
    }
    for (const reason of Object.keys(dropped) as DropReason[]) dropped[reason] = 0;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  },
  queued(): BlockEventRow[] {
    return queue.map((row) => ({ ...row }));
  },
  dropped(): Record<DropReason, number> {
    return { ...dropped };
  },
  timerArmed(): boolean {
    return timer !== null;
  },
};
