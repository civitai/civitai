/**
 * The registry source protocol, as the registry's TypeScript SDK speaks it over HTTP with
 * server-sent events: `GET /subscribe?schema=&cursor=&urn=&filter=` streams `upsert`* `live`
 * then `upsert`/`delete` with cursors, and `end` for a schema the source does not serve.
 * Kept wire-identical to that SDK so the adapter can sit behind any registry that speaks it.
 */

export type JsonSchema = Record<string, unknown> | boolean;

export interface Entity {
  urn: string;
  schemas: string[];
  rev: string;
  body: unknown;
}

export type Change = { upsert: Entity; cursor: string } | { delete: string; cursor: string };

export type StreamEvent =
  | { type: 'upsert'; entity: Entity; cursor: string }
  | { type: 'delete'; urn: string; cursor: string }
  | { type: 'live'; cursor: string }
  | { type: 'end' };

export interface SubscribeRequest {
  schema: string;
  cursor?: string;
  urns: string[];
  filter?: JsonSchema;
}

export type ErrorCode =
  | 'cursor_expired'
  | 'unknown_schema'
  | 'bad_request'
  | 'unavailable'
  | 'invalid_token'
  | 'insufficient_scope';

export const HTTP_STATUS: Record<ErrorCode, number> = {
  cursor_expired: 410,
  unknown_schema: 404,
  bad_request: 400,
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
}

export interface Adapter {
  namespace: string;
  /** Whether a subscription to `schema` is this source's to answer; any other gets `end`. */
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
   * arrives after `live` as an SSE `cursor_expired` error, so a consumer must handle both.
   */
  changes(schema: string, cursor: string, ctx: AdapterContext): Promise<AsyncIterable<Change>>;
}

export function parseSubscribeQuery(params: URLSearchParams): SubscribeRequest {
  const schema = params.get('schema');
  if (!schema) throw new ProtocolError('bad_request', 'schema is required');
  const filter = params.get('filter');
  let parsedFilter: JsonSchema | undefined;
  if (filter) {
    try {
      parsedFilter = JSON.parse(filter) as JsonSchema;
    } catch {
      throw new ProtocolError('bad_request', 'filter is not JSON');
    }
  }
  return {
    schema,
    cursor: params.get('cursor') || undefined,
    urns: params.getAll('urn'),
    filter: parsedFilter,
  };
}

/** One SSE frame, as the SDK writes it: the event name, then the event minus its `type`. */
export function sseFrame(event: StreamEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
