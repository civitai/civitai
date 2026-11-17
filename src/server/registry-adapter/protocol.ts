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

export type JsonSchema = Record<string, unknown> | boolean;

export interface Entity {
  urn: string;
  schemas: string[];
  rev: string;
  body: unknown;
}

/**
 * What an adapter's change feed yields: an upsert or a delete with the cursor after it, or a
 * `progress` cursor when the adapter's position moved with no change for the stream.
 */
export type Change =
  | { upsert: Entity; cursor: string }
  | { delete: string; cursor: string }
  | { progress: string };

export type StreamEvent =
  | { type: 'upsert'; entity: Entity; cursor: string }
  | { type: 'delete'; urn: string; cursor: string }
  | { type: 'live'; cursor: string }
  | { type: 'progress'; cursor: string }
  | { type: 'end' };

export interface SubscribeRequest {
  schema: string;
  cursor?: string;
  urns: string[];
  filter?: JsonSchema;
}

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
  changes(schema: string, cursor: string, ctx: AdapterContext): Promise<AsyncIterable<Change>>;
}

/**
 * A request as either binding received it, validated into a {@link SubscribeRequest}. `filter`
 * is the JSON text (both bindings carry it as a string); empty means none, as an empty `cursor`
 * does.
 */
export function subscribeRequest(raw: {
  schema: string | null | undefined;
  cursor: string | null | undefined;
  urns: readonly string[];
  filter: string | null | undefined;
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
  return { schema: raw.schema, cursor: raw.cursor || undefined, urns: [...raw.urns], filter };
}
