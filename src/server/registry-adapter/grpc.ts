/**
 * The gRPC binding of the source protocol (spec/registry.md @ 4166f34, "Bindings" → "gRPC"):
 * `service Source { rpc Subscribe(SubscribeRequest) returns (stream Event); }`, with the spec's
 * messages verbatim ({@link SOURCE_PROTO}). The subscription itself is the shared core
 * (`subscription.ts`), as for HTTP; this file maps the request in and events and errors out.
 *
 *   - The spec's proto block declares no `package`, so the method is `/Source/Subscribe`, the
 *     path a stub generated from that block calls.
 *   - An error is its gRPC status (spec "Errors") with a `google.rpc.ErrorInfo` whose `reason` is
 *     the error's name, in `grpc-status-details-bin`.
 *   - An idle stream is kept open by HTTP/2 pings ({@link GRPC_KEEPALIVE_MS}).
 *   - Auth (`auth.ts`): the token is the `authorization` metadata (`Bearer {token}`); without one
 *     the call is anonymous. `invalid_token` is UNAUTHENTICATED with an `ErrorInfo` reason
 *     `invalid_token`, before the stream or at the token's expiry / revocation after it.
 *   - A consumer that leaves the call's buffer full for `SLOW_CONSUMER_MS` is ended at once with
 *     an RST_STREAM that clients read as `RESOURCE_EXHAUSTED`, the status of `slow_consumer`
 *     (a status in trailers would queue behind what it never reads; `resetSlowConsumer`).
 *
 * Served on its own port, not multiplexed with the SSE port: `@grpc/grpc-js` owns its HTTP/2
 * server and takes no connections from another, while the SSE binding is a plain `node:http`
 * server. One cleartext port would need a sniffer routing the HTTP/2 preface to grpc-js's
 * experimental connection injector and everything else to `node:http`, for nothing an ingress
 * needs: it routes by port anyway, and gRPC needs an h2c backend where SSE needs HTTP/1.1.
 *
 * The messages are parsed from the inline {@link SOURCE_PROTO} text with `protobufjs` at
 * startup, so the bundle (`scripts/build-registry-adapter.mjs`) loads no `.proto` file at
 * runtime; `@grpc/grpc-js` and `protobufjs` stay external, like every root dependency.
 */
import * as grpc from '@grpc/grpc-js';
import type { ServerHttp2Stream } from 'node:http2';
import { constants as http2Constants } from 'node:http2';
import * as protobuf from 'protobufjs';
import type { ResourceConfig, VerifyToken } from '~/server/registry-adapter/auth';
import {
  authenticate,
  isAuthError,
  resourceMetadataUrl,
  watchPrincipal,
  wwwAuthenticate,
} from '~/server/registry-adapter/auth';
import type { Adapter, ErrorCode, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError, subscribeRequest } from '~/server/registry-adapter/protocol';
import type { EventSink } from '~/server/registry-adapter/subscription';
import {
  SLOW_CONSUMER_MS,
  createSubscriber,
  drained,
} from '~/server/registry-adapter/subscription';

/** The spec's proto block, unchanged but for the `syntax` and `import` lines it needs to parse. */
export const SOURCE_PROTO = `
syntax = "proto3";
import "google/protobuf/struct.proto";

service Source {
  rpc Subscribe(SubscribeRequest) returns (stream Event);
}

message SubscribeRequest {
  string schema = 1;
  string cursor = 2;          // empty: from the beginning
  repeated string urns = 3;   // empty: every entity
  string filter = 4;          // a JSON Schema, as JSON; empty: no filter
}

message Entity {
  string urn = 1;
  repeated string schemas = 2;
  string rev = 3;
  google.protobuf.Value body = 4;
  google.protobuf.Struct meta = 5;
}

message Event {
  oneof kind {
    Upsert upsert = 1;
    Delete delete = 2;
    Live live = 3;
    End end = 4;
    Progress progress = 6;
  }
  google.protobuf.Struct meta = 5;
}

message Upsert   { Entity entity = 1; string cursor = 2; }
message Delete   { string urn = 1; string cursor = 2; }
message Live     { string cursor = 1; }
message Progress { string cursor = 1; }
message End      {}
`;

/** `google.rpc.Status` and `google.rpc.ErrorInfo`, the standard error details. */
const ERROR_DETAILS_PROTO = `
syntax = "proto3";
package google.rpc;
import "google/protobuf/any.proto";

message Status {
  int32 code = 1;
  string message = 2;
  repeated google.protobuf.Any details = 3;
}

message ErrorInfo {
  string reason = 1;
  string domain = 2;
  map<string, string> metadata = 3;
}
`;

export const SUBSCRIBE_PATH = '/Source/Subscribe';
/** `ErrorInfo.domain`: the names are the registry protocol's, not this source's. */
export const ERROR_DOMAIN = 'registry';
const ERROR_INFO_TYPE_URL = 'type.googleapis.com/google.rpc.ErrorInfo';
export const GRPC_KEEPALIVE_MS = 15_000;
const GRPC_KEEPALIVE_TIMEOUT_MS = 10_000;

/** The spec's Errors table. */
export const GRPC_STATUS: Record<ErrorCode, grpc.status> = {
  bad_request: grpc.status.INVALID_ARGUMENT,
  unknown_schema: grpc.status.NOT_FOUND,
  cursor_expired: grpc.status.OUT_OF_RANGE,
  slow_consumer: grpc.status.RESOURCE_EXHAUSTED,
  unavailable: grpc.status.UNAVAILABLE,
  invalid_token: grpc.status.UNAUTHENTICATED,
  insufficient_scope: grpc.status.PERMISSION_DENIED,
};

function loadTypes() {
  const root = new protobuf.Root();
  for (const file of ['google/protobuf/struct.proto', 'google/protobuf/any.proto']) {
    const json = protobuf.common.get(file);
    if (!json?.nested) throw new Error(`registry-adapter: protobufjs has no ${file}`);
    root.addJSON(json.nested);
  }
  protobuf.parse(SOURCE_PROTO, root, { keepCase: true });
  protobuf.parse(ERROR_DETAILS_PROTO, root, { keepCase: true });
  root.resolveAll();
  return {
    request: root.lookupType('SubscribeRequest'),
    event: root.lookupType('Event'),
    status: root.lookupType('google.rpc.Status'),
    errorInfo: root.lookupType('google.rpc.ErrorInfo'),
  };
}
const types = loadTypes();

/**
 * A `google.protobuf.Value` as protobufjs takes and gives it. Its built-in well-known types name
 * their fields in camelCase whatever `keepCase` says (only the field numbers reach the wire).
 */
type PbValue = {
  nullValue?: number;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: { fields?: Record<string, PbValue> };
  listValue?: { values?: PbValue[] };
};

/** JSON as a `google.protobuf.Value`, with `JSON.stringify`'s rules for what JSON cannot hold. */
export function toValue(v: unknown): PbValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { numberValue: v } : { nullValue: 0 };
  if (Array.isArray(v)) return { listValue: { values: v.map(toValue) } };
  if (v !== null && typeof v === 'object') {
    const fields: Record<string, PbValue> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = toValue(x);
    return { structValue: { fields } };
  }
  return { nullValue: 0 };
}

export function fromValue(v: PbValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.listValue !== undefined) return (v.listValue.values ?? []).map(fromValue);
  if (v.structValue !== undefined) {
    return Object.fromEntries(
      Object.entries(v.structValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)])
    );
  }
  return null;
}

/** The wire form of one event. */
export function encodeEvent(e: StreamEvent): Buffer {
  let kind: Record<string, unknown>;
  switch (e.type) {
    case 'upsert':
      kind = {
        upsert: {
          entity: {
            urn: e.entity.urn,
            schemas: e.entity.schemas,
            rev: e.entity.rev,
            body: toValue(e.entity.body),
          },
          cursor: e.cursor,
        },
      };
      break;
    case 'delete':
      kind = { delete: { urn: e.urn, cursor: e.cursor } };
      break;
    case 'live':
      kind = { live: { cursor: e.cursor } };
      break;
    case 'progress':
      kind = { progress: { cursor: e.cursor } };
      break;
    case 'end':
      kind = { end: {} };
      break;
  }
  return Buffer.from(types.event.encode(types.event.fromObject(kind)).finish());
}

type WireEvent = {
  kind?: 'upsert' | 'delete' | 'live' | 'end' | 'progress';
  upsert?: {
    entity?: { urn?: string; schemas?: string[]; rev?: string; body?: PbValue };
    cursor?: string;
  };
  delete?: { urn?: string; cursor?: string };
  live?: { cursor?: string };
  progress?: { cursor?: string };
};

/** One event off the wire, as a consumer reads it; `null` for a kind this source never sends. */
export function decodeEvent(buf: Uint8Array): StreamEvent | null {
  const w = types.event.toObject(types.event.decode(buf), {
    oneofs: true,
    arrays: true,
  }) as WireEvent;
  switch (w.kind) {
    case 'upsert': {
      const entity = w.upsert?.entity ?? {};
      return {
        type: 'upsert',
        entity: {
          urn: entity.urn ?? '',
          schemas: entity.schemas ?? [],
          rev: entity.rev ?? '',
          body: fromValue(entity.body),
        },
        cursor: w.upsert?.cursor ?? '',
      };
    }
    case 'delete':
      return { type: 'delete', urn: w.delete?.urn ?? '', cursor: w.delete?.cursor ?? '' };
    case 'live':
      return { type: 'live', cursor: w.live?.cursor ?? '' };
    case 'progress':
      return { type: 'progress', cursor: w.progress?.cursor ?? '' };
    case 'end':
      return { type: 'end' };
    default:
      return null;
  }
}

export type WireRequest = { schema: string; cursor: string; urns: string[]; filter: string };

export const SOURCE_SERVICE: grpc.ServiceDefinition = {
  Subscribe: {
    path: SUBSCRIBE_PATH,
    requestStream: false,
    responseStream: true,
    requestSerialize: (r: WireRequest) =>
      Buffer.from(types.request.encode(types.request.fromObject(r)).finish()),
    requestDeserialize: (buf: Buffer) =>
      types.request.toObject(types.request.decode(buf), {
        defaults: true,
        arrays: true,
      }) as WireRequest,
    responseSerialize: encodeEvent,
    responseDeserialize: decodeEvent,
  },
};

/**
 * The trailers of an error: its status, and `ErrorInfo` naming it. An auth error also carries
 * `www-authenticate`, as over HTTP, naming the metadata document when one is configured.
 */
export function errorStatus(
  code: ErrorCode,
  message: string,
  resourceMetadata?: string
): Partial<grpc.StatusObject> {
  const info = types.errorInfo
    .encode(types.errorInfo.fromObject({ reason: code, domain: ERROR_DOMAIN }))
    .finish();
  const status = types.status
    .encode(
      types.status.fromObject({
        code: GRPC_STATUS[code],
        message,
        details: [{ type_url: ERROR_INFO_TYPE_URL, value: info }],
      })
    )
    .finish();
  const metadata = new grpc.Metadata();
  metadata.set('grpc-status-details-bin', Buffer.from(status));
  if (isAuthError(code)) {
    metadata.set('www-authenticate', wwwAuthenticate(code, message, resourceMetadata));
  }
  return { code: GRPC_STATUS[code], details: message, metadata };
}

/** The `ErrorInfo` of an error's trailers, as a consumer reads it; null when it has none. */
export function errorInfoOf(
  metadata: grpc.Metadata | undefined
): { reason: string; domain: string } | null {
  const raw = metadata?.get('grpc-status-details-bin')[0];
  if (!(raw instanceof Buffer)) return null;
  const status = types.status.toObject(types.status.decode(raw), { arrays: true }) as {
    details: Array<{ type_url: string; value: Uint8Array }>;
  };
  const detail = status.details.find((d) => d.type_url === ERROR_INFO_TYPE_URL);
  if (!detail) return null;
  return types.errorInfo.toObject(types.errorInfo.decode(detail.value)) as {
    reason: string;
    domain: string;
  };
}

type Call = grpc.ServerWritableStream<WireRequest, StreamEvent>;

/**
 * The HTTP/2 stream under a call. grpc-js has no public way to end a call ahead of what it
 * already buffered, so this reaches its internals: the call's `call` (a
 * `BaseServerInterceptingCall`, or interceptors wrapping one through `nextCall`) holds the
 * `stream`. `@grpc/grpc-js` is pinned exactly in package.json, and `grpc.test.ts` pins the
 * behaviour, so a version that moves it goes red rather than silently.
 */
function http2StreamOf(call: Call): ServerHttp2Stream | null {
  let at: unknown = (call as unknown as { call?: unknown }).call;
  for (let depth = 0; at && depth < 8; depth++) {
    const stream = (at as { stream?: unknown }).stream;
    if (stream && typeof (stream as ServerHttp2Stream).close === 'function') {
      return stream as ServerHttp2Stream;
    }
    at = (at as { nextCall?: unknown }).nextCall;
  }
  return null;
}

/**
 * Ends a call whose consumer stopped reading, now. A gRPC status travels as trailers at the END
 * of the HTTP/2 stream, behind every message the consumer has not read, so it would never arrive
 * and the call would stay open. An RST_STREAM is not flow-controlled: sent with
 * ENHANCE_YOUR_CALM, clients map it to RESOURCE_EXHAUSTED, the status of `slow_consumer` (gRPC's
 * HTTP/2 protocol mapping). It carries no `ErrorInfo`; the consumer's action is the same either
 * way: reconnect with its cursor.
 */
function resetSlowConsumer(call: Call): boolean {
  const stream = http2StreamOf(call);
  if (!stream || stream.destroyed) return false;
  stream.close(http2Constants.NGHTTP2_ENHANCE_YOUR_CALM);
  return true;
}

function openCall(
  call: Call,
  slowConsumerMs: number
): EventSink & { ended(): boolean; fail(status: Partial<grpc.StatusObject>): void } {
  const abort = new AbortController();
  let ended = false;
  call.on('cancelled', () => abort.abort());
  return {
    signal: abort.signal,
    ended: () => ended,
    /** Ends the call now with `status`, stopping the subscription behind it. */
    fail(status) {
      if (ended || abort.signal.aborted) return;
      ended = true;
      abort.abort();
      call.emit('error', status);
    },
    async send(event) {
      if (abort.signal.aborted || ended) return;
      const flushed = call.write(event);
      if (event.type === 'end') {
        ended = true;
        call.end();
      } else if (!flushed) {
        await drained(call, abort.signal, slowConsumerMs);
      }
    },
  };
}

/** The `authorization` metadata of a call: its last string value. */
function authorizationOf(call: Call): string | undefined {
  const values = call.metadata
    .get('authorization')
    .filter((v): v is string => typeof v === 'string');
  return values[values.length - 1];
}

export function createGrpcServer(
  adapter: Adapter,
  opts: {
    onError?: (err: unknown) => void;
    slowConsumerMs?: number;
    /** As for HTTP (`serve.ts`): without it, any token is `invalid_token`. */
    verifyToken?: VerifyToken;
    resource?: ResourceConfig;
    tokenRecheckMs?: number;
  } = {}
): grpc.Server {
  const subscribe = createSubscriber(adapter);
  const metadataUrl = resourceMetadataUrl(opts.resource);
  const server = new grpc.Server({
    'grpc.keepalive_time_ms': GRPC_KEEPALIVE_MS,
    'grpc.keepalive_timeout_ms': GRPC_KEEPALIVE_TIMEOUT_MS,
  });
  server.addService(SOURCE_SERVICE, {
    Subscribe: (call: Call) => {
      const sink = openCall(call, opts.slowConsumerMs ?? SLOW_CONSUMER_MS);
      const run = async () => {
        let unwatch: (() => void) | undefined;
        try {
          const r = call.request;
          const request = subscribeRequest({
            schema: r.schema,
            cursor: r.cursor,
            urns: r.urns,
            filter: r.filter,
          });
          const principal = await authenticate(authorizationOf(call), opts.verifyToken);
          unwatch = watchPrincipal(
            principal,
            (err) => sink.fail(errorStatus(err.code, err.message, metadataUrl)),
            { recheckMs: opts.tokenRecheckMs }
          );
          await subscribe(request, sink, principal);
        } catch (err) {
          if (sink.ended() || sink.signal.aborted) return;
          if (
            err instanceof ProtocolError &&
            err.code === 'slow_consumer' &&
            resetSlowConsumer(call)
          ) {
            return;
          }
          // As over HTTP: a `ProtocolError` is sent as is, anything else as `unavailable` with
          // a fixed message, since its own text can name a database or a host.
          let status: Partial<grpc.StatusObject>;
          if (err instanceof ProtocolError) {
            status = errorStatus(err.code, err.message, metadataUrl);
          } else {
            opts.onError?.(err);
            status = errorStatus('unavailable', 'unavailable');
          }
          call.emit('error', status);
        } finally {
          unwatch?.();
        }
      };
      void run();
    },
  });
  return server;
}

/** Binds `server` on every interface; resolves with the port bound (for `port` 0, the chosen one). */
export function listenGrpc(server: grpc.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) =>
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound)
    )
  );
}
