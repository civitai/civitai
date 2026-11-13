// Last-known flag state, so a process that starts while Flipt is unreachable can still evaluate.
//
// The pinned SDK (@flipt-io/flipt-client-js 0.2.0) has no snapshot option: `FliptClient.init`
// builds its engine from the first response of its fetcher, and it never exposes that response. So
// this module owns the fetcher. The live fetcher does what the SDK's built-in one does (same URL,
// headers and error rule) with a timeout added, and hands every evaluation snapshot it receives to
// the caller. A seeded client is an ordinary `FliptClient.init` whose fetcher returns a stored
// snapshot instead of calling Flipt.
import type { IFetcher, Response as FliptResponse } from '@flipt-io/flipt-client-js';

/** One evaluation snapshot as Flipt served it, with when a live fetch last confirmed it. */
export type FliptSnapshot = {
  /** Epoch ms of the live fetch that last confirmed this state. */
  savedAt: number;
  /** Flipt's ETag for `data`, when it sent one. */
  etag?: string | null;
  /** The body of `GET /internal/v1/evaluation/snapshot/namespace/<ns>`, untouched. */
  data: unknown;
};

/** Where an app keeps the last-known snapshot. INJECTED so this package owns no storage client. */
export type FliptSnapshotStore = {
  load(): Promise<FliptSnapshot | null>;
  /** `changed` is true when `data` differs from the state this process held before. */
  save(snapshot: FliptSnapshot, changed: boolean): Promise<void>;
};

// The SDK sends this header on every snapshot request; copied from its 0.2.0 build so a server
// sees the same request whichever fetcher made it.
const ACCEPT_SERVER_VERSION = '1.47.0';

export function fliptSnapshotUrl(baseUrl: string, namespace = 'default'): string {
  return `${baseUrl.replace(/\/$/, '')}/internal/v1/evaluation/snapshot/namespace/${namespace}`;
}

/**
 * The live fetcher. Matches the SDK's own (0.2.0) request and its error rule: anything other than a
 * 2xx or a 304 throws. Adds a per-request timeout, which the SDK's has none of, so neither init nor a
 * poll can hang on a Flipt that accepts the connection and never answers.
 *
 * `onSnapshot` gets each snapshot body when the SDK reads it (a 304 has none). `onConfirmed` runs
 * after every 2xx or 304, so a caller can tell "Flipt agreed the state is current" from "nothing
 * changed because Flipt is down".
 */
export function createLiveFetcher({
  url,
  clientToken,
  environment,
  namespace,
  timeoutMs,
  onSnapshot,
  onConfirmed,
}: {
  url: string;
  clientToken: string;
  environment: string;
  namespace?: string;
  timeoutMs: number;
  onSnapshot?: (data: unknown, etag: string | null) => void;
  onConfirmed?: () => void;
}): IFetcher {
  const target = fliptSnapshotUrl(url, namespace);
  return async (opts) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-flipt-accept-server-version': ACCEPT_SERVER_VERSION,
      'x-flipt-environment': environment,
      Authorization: `Bearer ${clientToken}`,
    };
    if (opts?.etag) headers['If-None-Match'] = opts.etag;
    const resp = await fetch(target, {
      method: 'GET',
      headers,
      // Next.js patches the global fetch with a data cache; this must always reach Flipt.
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok && resp.status !== 304) {
      throw new Error(`Failed to fetch data: ${resp.statusText}`);
    }
    onConfirmed?.();
    const etag = resp.headers.get('etag');
    const wrapped: FliptResponse = {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: { get: (name) => resp.headers.get(name) },
      json: async () => {
        const data = await resp.json();
        onSnapshot?.(data, etag);
        return data;
      },
    };
    return wrapped;
  };
}

/** A fetcher that answers with a stored snapshot. For a seeded client, which never polls. */
export function createSnapshotFetcher(data: unknown): IFetcher {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => data,
  });
}

/** The minimal key-value surface `createKvSnapshotStore` needs. */
export type FliptSnapshotKv = {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
};

type SnapshotMeta = { savedAt: number; etag?: string | null };

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * A snapshot store over any key-value store with TTLs (the monolith passes sysRedis).
 *
 * Every process that holds live state calls `save`; this keeps the write rate near one per
 * `refreshIntervalMs` across all of them. A small meta key (`<key>:meta`) holds what is stored, and
 * the body is rewritten only when
 *   - the caller's state CHANGED and differs from what is stored (a flag flip), or
 *   - it is the state already stored and that copy is older than `refreshIntervalMs` (so its age
 *     keeps meaning "how long since Flipt last confirmed it"), or
 *   - what is stored is older than twice `refreshIntervalMs`, whatever it holds (nobody is keeping
 *     it current, so the stored copy is not a newer state this caller missed).
 * A process whose own copy is merely unchanged and differs from the stored one leaves it alone: it
 * may be the one behind.
 *
 * Before enabling FLIPT_SNAPSHOT_MAX_AGE_MS, confirm Flipt sends an ETag on the snapshot endpoint:
 * without one every response is a full body, so every process rewrites the snapshot on every poll.
 */
export function createKvSnapshotStore({
  kv,
  key,
  maxAgeMs,
  refreshIntervalMs,
  maxBytes = 8 * 1024 * 1024,
  log = console.log,
}: {
  kv: FliptSnapshotKv;
  key: string;
  /** Stored keys expire after this; `load` also refuses anything older. */
  maxAgeMs: number;
  refreshIntervalMs: number;
  maxBytes?: number;
  log?: (message: string, ...args: unknown[]) => void;
}): FliptSnapshotStore {
  const metaKey = `${key}:meta`;
  return {
    async load() {
      const snapshot = parseJson<FliptSnapshot>(await kv.get(key));
      if (!snapshot || typeof snapshot.savedAt !== 'number' || !snapshot.data) return null;
      return snapshot;
    },
    async save(snapshot, changed) {
      const meta = parseJson<SnapshotMeta>(await kv.get(metaKey));
      if (meta && typeof meta.savedAt === 'number') {
        const age = snapshot.savedAt - meta.savedAt;
        // Without an ETag there is nothing to compare, so the caller's own `changed` decides.
        const same = snapshot.etag ? meta.etag === snapshot.etag : !changed;
        const write =
          (changed && !same) || (same && age >= refreshIntervalMs) || age >= 2 * refreshIntervalMs;
        if (!write) return;
      }
      const body = JSON.stringify(snapshot);
      if (body.length > maxBytes) {
        log(`[flipt] snapshot not saved: ${body.length} bytes is over the ${maxBytes} byte cap`);
        return;
      }
      await kv.set(key, body, maxAgeMs);
      await kv.set(
        metaKey,
        JSON.stringify({ savedAt: snapshot.savedAt, etag: snapshot.etag ?? null }),
        maxAgeMs
      );
    },
  };
}
