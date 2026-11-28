/**
 * The registry protocol, `Subscribe`, as the registry spec defines it. It has two bindings,
 * served from one core (`subscription.ts`): HTTP with server-sent events (`serve.ts`) and gRPC
 * (`grpc.ts`).
 *
 * A subscription streams `upsert`* `live`, then `upsert`/`delete` with cursors, and `progress`
 * when the position moves with nothing to send; `end` answers a request this source can never
 * serve anything for: a schema it does not serve, or `urns` none of which is of its namespace.
 */
import type { Audience } from '~/server/registry-adapter/audience';
import type { PrincipalToken } from '~/server/registry-adapter/auth';

export type JsonSchema = Record<string, unknown> | boolean;

export interface Entity {
  urn: string;
  schemas: string[];
  rev: string;
  body: unknown;
  /**
   * A private document's storage key (`private-feed.ts`), beside the body so the body stays the
   * document its schemas claim. Only the private feed sets it, on a stream that belongs to one
   * user's token. Sent by the HTTP binding; the gRPC `Entity` message has no field for it.
   */
  key?: string;
  /**
   * A private document's `seq` (`private-feed.ts`): where its last write sits in its app
   * namespace's write order, the order a stream's head (`EventMeta`) is compared in. Set, sent and
   * withheld exactly as `key` is. A shared-collection level stream (`level-feed.ts`) sets it too.
   */
  seq?: number;
  /**
   * What a shared-collection LEVEL STREAM's entity carries beside its body (`level-feed.ts`): the
   * document's `version`, its `createdAt` and `updatedAt` (ISO 8601). A plain document: no author,
   * no tallies, no marks. Set by the level feed, sent by the HTTP binding only, as `key` is. The
   * private feed (`private-feed.ts`) sets `version` too, never the timestamps.
   */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * What a `live`, `progress` or `end` event tells its consumer beside the cursor (the spec's
 * `Event.meta`: a JSON object; absent is none). The private feed sets its heads
 * (`private-feed.ts`); a level stream its head, its levels mode and its block, and on `end` the
 * reason it ended (`level-feed.ts`).
 */
export type EventMeta = Record<string, unknown>;

/**
 * An adapter ending a stream on purpose, with the `meta` its `end` event carries (its `reason`):
 * thrown by `snapshot` or `changes` before anything is sent, so the subscription is answered with
 * that `end` alone, or yielded mid-stream as a {@link Change}. Only the level feed ends a stream
 * this way (`level-feed.ts`); every other `end` carries no meta.
 */
export class StreamEnd extends Error {
  readonly meta: EventMeta;
  constructor(meta: EventMeta) {
    super(`stream ended: ${String(meta.reason ?? 'no reason')}`);
    this.meta = meta;
  }
}

/**
 * What an adapter's change feed yields: an upsert or a delete with the cursor after it, or a
 * `progress` cursor when the adapter's position moved with no change for the stream.
 */
export type Change =
  | { upsert: Entity; cursor: string }
  | { delete: string; cursor: string }
  | { progress: string; meta?: EventMeta }
  | { end: EventMeta };

/**
 * What `Adapter.changes` resolves to: the changes, and the `meta` the `live` event before them
 * carries, when the adapter has one.
 */
export type Changes = AsyncIterable<Change> & { liveMeta?: EventMeta };

export type StreamEvent =
  | { type: 'upsert'; entity: Entity; cursor: string }
  | { type: 'delete'; urn: string; cursor: string }
  | { type: 'live'; cursor: string; meta?: EventMeta }
  | { type: 'progress'; cursor: string; meta?: EventMeta }
  | { type: 'end'; meta?: EventMeta };

export interface SubscribeRequest {
  schema: string;
  cursor?: string;
  urns: string[];
  filter?: JsonSchema;
  /** What the caller tells the origin (spec rule 10): a JSON object; absent when none. */
  meta?: RequestMeta;
}

export type RequestMeta = Record<string, unknown>;

/**
 * The spec's error names, the auth extension's two, and `unavailable` for the spec's "anything
 * else", whose consumer reconnects with backoff.
 */
export type ErrorCode =
  | 'cursor_expired'
  | 'bad_request'
  | 'slow_consumer'
  | 'unavailable'
  | 'invalid_token'
  | 'insufficient_scope';

/**
 * The HTTP status of an error sent before the stream starts. `slow_consumer` is only ever sent
 * after it (as an `error` event), so the spec gives it none; 503 is here for completeness.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  cursor_expired: 410,
  bad_request: 400,
  slow_consumer: 503,
  unavailable: 503,
  invalid_token: 401,
  insufficient_scope: 403,
};

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const cursorExpired = (why?: string) => new ProtocolError('cursor_expired', why);

export interface AdapterContext {
  signal: AbortSignal;
  /**
   * What the subscription's token may read (`audience.ts`). Absent is anonymous, the narrowest.
   * The document, app, app-release and schema streams narrow by it (`audience.ts`); the
   * `service` stream is the same for every audience.
   */
  audience?: Audience;
  /**
   * The subscription's accepted token, with its subject: what an authorized PRIVATE stream's gates
   * read (`private-feed.ts`). Absent or null is anonymous. No other stream reads it.
   */
  reader?: (PrincipalToken & { subject: string }) | null;
  /**
   * The request's `meta` (spec rule 10). The level feed reads it, to route and bind a subscription
   * (`level-feed.ts`); the private feed reads only its `sync` (`private-feed.ts`, THE FIRST POLL'S
   * SYNC), which neither routes nor binds anything.
   */
  meta?: RequestMeta;
  /**
   * The binding the subscription arrived on; absent is HTTP. Only the level feed reads it: it
   * refuses a gRPC level subscription (`level-feed.ts`), whose entities `Entity` cannot carry.
   */
  binding?: 'http' | 'grpc';
}

export interface Adapter {
  namespace: string;
  /**
   * Whether this source may ever serve `schema`. One it never can (another namespace, a shape its
   * URNs never take) is answered `end` before anything else; `end` means never. A schema it may
   * publish later (a major not minted yet, a collection not exported yet) is served, empty until
   * then.
   */
  serves(schema: string): boolean;
  snapshot(
    schema: string,
    ctx: AdapterContext
  ): Promise<{ cursor: string; entities: Iterable<Entity> | AsyncIterable<Entity> }>;
  /**
   * The changes after `cursor`. The cursor is checked before this resolves: it rejects with
   * {@link cursorExpired} for a cursor it cannot resume from, so a cursor refused on resume is
   * answered before `live` (HTTP 410). A cursor that goes stale DURING the stream (the document
   * feed's later polls, e.g. its app re-created mid-stream) is thrown by the iterable and still
   * arrives after `live` as a `cursor_expired` error, so a consumer must handle both.
   */
  changes(schema: string, cursor: string, ctx: AdapterContext): Promise<Changes>;
}

/**
 * A request as either binding received it, validated into a {@link SubscribeRequest}. `filter`
 * is the JSON text (both bindings carry it as a string); empty means none, as an empty `cursor`
 * does. `meta` is JSON text over HTTP and its UTF-8 bytes over gRPC; anything but a JSON object
 * is none, since the spec gives no error for it and an origin ignores what it does not know.
 */
export function subscribeRequest(raw: {
  schema: string | null | undefined;
  cursor: string | null | undefined;
  urns: readonly string[];
  filter: string | null | undefined;
  meta?: string | Uint8Array | null;
}): SubscribeRequest {
  if (!raw.schema) throw new ProtocolError('bad_request', 'schema is required');
  let filter: JsonSchema | undefined;
  if (raw.filter) {
    try {
      filter = JSON.parse(raw.filter) as JsonSchema;
    } catch {
      throw new ProtocolError('bad_request', 'filter is not JSON');
    }
  }
  return {
    schema: raw.schema,
    cursor: raw.cursor || undefined,
    urns: [...raw.urns],
    filter,
    meta: requestMeta(raw.meta),
  };
}

function requestMeta(raw: string | Uint8Array | null | undefined): RequestMeta | undefined {
  if (!raw || raw.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return undefined;
  }
  return jsonObjectOrUndefined(value);
}

/**
 * A parsed JSON value as a `meta` (`RequestMeta`, `EventMeta`) holds it: a JSON object, else
 * nothing (an array, `null` or a primitive). The one rule both bindings read a `meta` by.
 */
export function jsonObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
