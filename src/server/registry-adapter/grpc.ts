/**
 * The gRPC binding of the registry protocol (the registry spec, "Bindings" → "gRPC"):
 * `package registry.v1; service Registry { rpc Subscribe(SubscribeRequest) returns (stream Event); }`,
 * with the spec's messages verbatim ({@link REGISTRY_PROTO}). The subscription itself is the shared
 * core (`subscription.ts`), as for HTTP; this file maps the request in and events and errors out.
 *
 *   - The method is `/registry.v1.Registry/Subscribe` ({@link SUBSCRIBE_PATH}), the path the spec
 *     names and a stub generated from its proto block calls. The earlier spec's
 *     `/Source/Subscribe` is not served (UNIMPLEMENTED).
 *   - `Entity.body` is the body's JSON text as UTF-8 bytes, the text the HTTP binding sends for
 *     it ({@link jsonBytes}), so a relay can pass it on byte for byte. `Entity.meta` and
 *     `Event.meta` are bytes too (a JSON object; empty is none): this source sets no `meta`, so it
 *     sends them empty, which is absent on the wire.
 *   - An error is its gRPC status (spec "Errors") with a `google.rpc.ErrorInfo` whose `reason` is
 *     the error's name, and no `domain` (the spec defines none), in `grpc-status-details-bin`.
 *   - An idle stream is kept open by HTTP/2 pings ({@link GRPC_KEEPALIVE_MS}).
 *   - Auth (`auth.ts`): the token is the `authorization` metadata (`Bearer {token}`); without one
 *     the call is anonymous. `invalid_token` is UNAUTHENTICATED with an `ErrorInfo` reason
 *     `invalid_token`, before the stream or at the token's expiry / revocation after it; a user
 *     whose ratings changed mid-stream gets OUT_OF_RANGE / `cursor_expired`.
 *   - A subscription over a cap on open subscriptions (`limits.ts`) is UNAVAILABLE /
 *     `unavailable`, before the stream.
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
 * The messages are parsed from the inline {@link REGISTRY_PROTO} text with `protobufjs` at
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
import type { SubscriptionLimiter, SubscriptionSlot } from '~/server/registry-adapter/limits';
import type { Adapter, ErrorCode, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError, subscribeRequest } from '~/server/registry-adapter/protocol';
import type { RequestOrigin } from '~/server/registry-adapter/request-origin';
import {
  clientAddress,
  peerAddress,
  regionRestricted,
} from '~/server/registry-adapter/request-origin';
import type { EventSink } from '~/server/registry-adapter/subscription';
import {
  SLOW_CONSUMER_MS,
  createSubscriber,
  drained,
} from '~/server/registry-adapter/subscription';

/** The spec's proto block, unchanged but for the `syntax` line it needs to parse. */
export const REGISTRY_PROTO = `
syntax = "proto3";

package registry.v1;

service Registry {
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
  bytes body = 4;             // the JSON value, as UTF-8
  bytes meta = 5;             // a JSON object, as UTF-8; empty: none
}

message Event {
  oneof kind {
    Upsert upsert = 1;
    Delete delete = 2;
    Live live = 3;
    End end = 4;
    Progress progress = 6;
  }
  bytes meta = 5;             // a JSON object, as UTF-8; empty: none
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

export const SUBSCRIBE_PATH = '/registry.v1.Registry/Subscribe';
const ERROR_INFO_TYPE_URL = 'type.googleapis.com/google.rpc.ErrorInfo';
export const GRPC_KEEPALIVE_MS = 15_000;
const GRPC_KEEPALIVE_TIMEOUT_MS = 10_000;

/** The spec's Errors table. */
export const GRPC_STATUS: Record<ErrorCode, grpc.status> = {
  bad_request: grpc.status.INVALID_ARGUMENT,
  cursor_expired: grpc.status.OUT_OF_RANGE,
  slow_consumer: grpc.status.RESOURCE_EXHAUSTED,
  unavailable: grpc.status.UNAVAILABLE,
  invalid_token: grpc.status.UNAUTHENTICATED,
  insufficient_scope: grpc.status.PERMISSION_DENIED,
};

function loadTypes() {
  const root = new protobuf.Root();
  for (const file of ['google/protobuf/any.proto']) {
    const json = protobuf.common.get(file);
    if (!json?.nested) throw new Error(`registry-adapter: protobufjs has no ${file}`);
    root.addJSON(json.nested);
  }
  protobuf.parse(REGISTRY_PROTO, root, { keepCase: true });
  protobuf.parse(ERROR_DETAILS_PROTO, root, { keepCase: true });
  root.resolveAll();
  return {
    request: root.lookupType('registry.v1.SubscribeRequest'),
    event: root.lookupType('registry.v1.Event'),
    status: root.lookupType('google.rpc.Status'),
    errorInfo: root.lookupType('google.rpc.ErrorInfo'),
  };
}
const types = loadTypes();

/**
 * A body as `Entity.body` carries it: its JSON text, UTF-8. `JSON.stringify`'s, the same text the
 * HTTP binding sends for it (`serve.ts`), so what JSON cannot hold (a non-finite number, an
 * `undefined` property) is dropped or `null` alike on both bindings. A body with no JSON at all
 * (`undefined`) is `null`.
 */
export function jsonBytes(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
}

/** `Entity.body` as a consumer reads it: the JSON value its bytes hold; `null` when empty. */
export function fromJsonBytes(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.length === 0) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
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
            body: jsonBytes(e.entity.body),
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
    entity?: { urn?: string; schemas?: string[]; rev?: string; body?: Uint8Array };
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
          body: fromJsonBytes(entity.body),
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

/** `registry.v1.Registry`, the spec's service. */
export const REGISTRY_SERVICE: grpc.ServiceDefinition = {
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
    // No `domain`: the spec names an error by the `ErrorInfo`'s `reason` alone ("Errors") and
    // defines no domain for the protocol's names, so none is invented for a consumer to match on.
    // Left out, not set to '', which protobufjs would still put on the wire.
    .encode(types.errorInfo.fromObject({ reason: code }))
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
  const info = types.errorInfo.toObject(types.errorInfo.decode(detail.value)) as {
    reason?: string;
    domain?: string;
  };
  // An empty field is absent on the wire: this source's `domain` always is.
  return { reason: info.reason ?? '', domain: info.domain ?? '' };
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

/**
 * A call's origin (`request-origin.ts`): its string metadata as headers (the last value of each,
 * as `authorizationOf` reads it) and its peer's address.
 */
function originOf(call: Call): RequestOrigin {
  const headers: Record<string, string> = {};
  for (const [name, values] of Object.entries(call.metadata.toJSON())) {
    const strings = values.filter((v): v is string => typeof v === 'string');
    if (strings.length > 0) headers[name] = strings[strings.length - 1];
  }
  return { headers, remoteAddress: peerAddress(call.getPeer()) };
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
    /** As for HTTP: the caps (`limits.ts`), the same limiter as the HTTP binding's. */
    limiter?: SubscriptionLimiter;
    /** As for HTTP: the site's region rule unless replaced. */
    regionRestricted?: (origin: RequestOrigin) => boolean;
  } = {}
): grpc.Server {
  const subscribe = createSubscriber(adapter);
  const metadataUrl = resourceMetadataUrl(opts.resource);
  const server = new grpc.Server({
    'grpc.keepalive_time_ms': GRPC_KEEPALIVE_MS,
    'grpc.keepalive_timeout_ms': GRPC_KEEPALIVE_TIMEOUT_MS,
  });
  server.addService(REGISTRY_SERVICE, {
    Subscribe: (call: Call) => {
      const sink = openCall(call, opts.slowConsumerMs ?? SLOW_CONSUMER_MS);
      const run = async () => {
        let unwatch: (() => void) | undefined;
        let slot: SubscriptionSlot | undefined;
        try {
          const r = call.request;
          const request = subscribeRequest({
            schema: r.schema,
            cursor: r.cursor,
            urns: r.urns,
            filter: r.filter,
          });
          const origin = originOf(call);
          // The total and per-address caps before the token is verified; per token once it is.
          slot = opts.limiter?.acquire(clientAddress(origin));
          const restricted = opts.regionRestricted ?? regionRestricted;
          const principal = await authenticate(authorizationOf(call), opts.verifyToken, {
            regionRestricted: () => restricted(origin),
          });
          slot?.claim(principal.subject);
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
          slot?.release();
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
