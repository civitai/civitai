/**
 * The HTTP binding of the registry protocol (the registry spec, "Bindings" → "HTTP"):
 * `GET /subscribe?schema=&cursor=&urn=&filter=` streaming `text/event-stream`, plus `/healthz`
 * for a process supervisor. Everything between request and events is the shared core
 * (`subscription.ts`); this file only maps the request in and the events and errors out.
 *
 *   - Each event is an SSE event of its type; one with a cursor field also carries it as the SSE
 *     `id`, an empty `id` when the cursor is empty, so a client may resume with `Last-Event-ID`
 *     instead of `cursor`. When a request has both,
 *     `Last-Event-ID` wins: an `EventSource` reconnects to its original URL, `cursor` and all,
 *     and sets the header to the last event it received, which is always the later position.
 *   - An error before the stream starts is its HTTP status with `{ "error", "message" }`; after,
 *     an `error` event with the same data.
 *   - An idle stream gets an SSE comment line every {@link HEARTBEAT_MS}, which proxies count as
 *     traffic.
 *   - A consumer that keeps the socket's buffer full for {@link SLOW_CONSUMER_MS} is ended with
 *     `slow_consumer`.
 *   - Auth (`auth.ts`): the token is the `Authorization: Bearer` header; without one the request
 *     is anonymous. `invalid_token` before the stream is 401 with its JSON body and a
 *     `WWW-Authenticate: Bearer error=…` header; after, an `error` event, at the token's expiry or
 *     when a re-check finds it revoked (or `cursor_expired` when the user's ratings changed). `/.well-known/oauth-protected-resource` is served when a
 *     resource is configured.
 *
 * Served as HTTP/1.1, which the spec allows ("HTTP/1.1 works"); see `grpc.ts` for why the gRPC
 * binding has its own port.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { ResourceConfig, VerifyToken } from '~/server/registry-adapter/auth';
import {
  PROTECTED_RESOURCE_PATH,
  authenticate,
  isAuthError,
  protectedResourceMetadata,
  resourceMetadataUrl,
  watchPrincipal,
  wwwAuthenticate,
} from '~/server/registry-adapter/auth';
import type { Adapter, ErrorCode, StreamEvent } from '~/server/registry-adapter/protocol';
import { HTTP_STATUS, ProtocolError, subscribeRequest } from '~/server/registry-adapter/protocol';
import type { EventSink } from '~/server/registry-adapter/subscription';
import {
  SLOW_CONSUMER_MS,
  createSubscriber,
  drained,
} from '~/server/registry-adapter/subscription';

const HEARTBEAT_MS = 15_000;
const CORS = { 'access-control-allow-origin': '*' };

/**
 * One SSE frame: the event name, then for an event with a cursor field its cursor as the `id`,
 * then its fields. An empty cursor (a snapshot upsert: a snapshot cannot be continued) is an
 * empty `id:` line, not an omitted one, so the client's `Last-Event-ID` resets rather than
 * keeping an older cursor that would miss deletes. `end` has no cursor field, and no `id`.
 */
export function sseFrame(event: StreamEvent): string {
  const { type, ...data } = event;
  const id = 'cursor' in event ? (event.cursor === '' ? 'id:\n' : `id: ${event.cursor}\n`) : '';
  return `event: ${type}\n${id}data: ${JSON.stringify(data)}\n\n`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...headers });
  res.end(JSON.stringify(body));
}

/**
 * A `ProtocolError` is sent as is. Anything else is `unavailable` with a fixed message: its own
 * text can name a database or a host, and this endpoint is public.
 */
function sendError(
  res: ServerResponse,
  err: unknown,
  onError?: (err: unknown) => void,
  resourceMetadata?: string
) {
  let code: ErrorCode = 'unavailable';
  let message = 'unavailable';
  if (err instanceof ProtocolError) {
    code = err.code;
    message = err.message;
  } else {
    onError?.(err);
  }
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.end(`event: error\ndata: ${JSON.stringify({ error: code, message })}\n\n`);
    // A consumer that stopped reading would hold the socket (and the error frame) forever:
    // `slow_consumer` frees it. Its consumer reconnects from its cursor either way.
    if (code === 'slow_consumer') res.destroy();
  } else {
    // An auth error before the stream starts names the metadata document too (auth extension,
    // "Errors"; RFC 6750 and RFC 9728).
    const headers: Record<string, string> = isAuthError(code)
      ? { 'www-authenticate': wwwAuthenticate(code, message, resourceMetadata) }
      : {};
    sendJson(res, HTTP_STATUS[code], { error: code, message }, headers);
  }
}

/**
 * The stream's sink, and `stop`, which every path that ends the response calls FIRST (an `end`
 * event, an error, `slow_consumer`, the consumer going away). The heartbeat timer is cleared
 * there, not on `close`: a consumer that stopped reading delays `close` indefinitely, and a
 * heartbeat written after the response ended would be a write after end.
 */
function openStream(
  res: ServerResponse,
  slowConsumerMs: number
): { sink: EventSink; stop: () => void } {
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    abort.abort();
  };
  if (res.closed) {
    stop();
    return { sink: { signal: abort.signal, send: async () => undefined }, stop };
  }
  const ended = () => res.writableEnded || res.destroyed;
  res.on('close', stop);
  // A socket error (a reset mid-write) must never be unhandled: the stream just stops.
  res.on('error', stop);
  let started = false;
  const sink: EventSink = {
    signal: abort.signal,
    async send(event) {
      if (abort.signal.aborted || ended()) return;
      if (!started) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          ...CORS,
        });
        started = true;
        // Armed only once the head is written: a heartbeat before it would send default
        // headers, and the writeHead above would then throw.
        heartbeat = setInterval(() => {
          if (ended()) stop();
          else res.write(': heartbeat\n\n');
        }, HEARTBEAT_MS);
      }
      const flushed = res.write(sseFrame(event));
      if (event.type === 'end') {
        stop();
        res.end();
      } else if (!flushed) {
        await drained(res, abort.signal, slowConsumerMs);
      }
    },
  };
  return { sink, stop };
}

/**
 * The cursor a request resumes from: `Last-Event-ID` when set (see the file comment), else
 * `cursor`. An empty `Last-Event-ID` is the empty cursor the client stored (a snapshot it must
 * start over), so it falls through to `cursor`, which such a client does not send either.
 */
function resumeCursor(req: IncomingMessage, params: URLSearchParams): string | null {
  const header = req.headers['last-event-id'];
  const lastEventId = Array.isArray(header) ? header[header.length - 1] : header;
  return lastEventId || params.get('cursor');
}

/** The last value of a header a client may have sent more than once. */
function lastHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export type ServeOptions = {
  onError?: (err: unknown) => void;
  slowConsumerMs?: number;
  /** The site's token verification (`auth.live.ts`). Without it, any token is `invalid_token`. */
  verifyToken?: VerifyToken;
  /** Advertised as protected resource metadata, and named by every auth error. */
  resource?: ResourceConfig;
  /** How often an open stream's token is re-verified (`auth.ts`). */
  tokenRecheckMs?: number;
};

export function handleRequest(
  adapter: Adapter,
  opts: ServeOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const subscribe = createSubscriber(adapter);
  const metadataUrl = resourceMetadataUrl(opts.resource);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname === PROTECTED_RESOURCE_PATH && opts.resource) {
      return sendJson(res, 200, protectedResourceMetadata(opts.resource));
    }
    if (url.pathname !== '/subscribe') {
      return sendError(res, new ProtocolError('bad_request', `no route ${url.pathname}`));
    }
    let stream: ReturnType<typeof openStream> | undefined;
    let unwatch: (() => void) | undefined;
    try {
      const request = subscribeRequest({
        schema: url.searchParams.get('schema'),
        cursor: resumeCursor(req, url.searchParams),
        urns: url.searchParams.getAll('urn'),
        filter: url.searchParams.get('filter'),
      });
      const principal = await authenticate(lastHeader(req.headers.authorization), opts.verifyToken);
      const open = openStream(res, opts.slowConsumerMs ?? SLOW_CONSUMER_MS);
      stream = open;
      // The stream ends with `invalid_token` once its token does (auth extension, Relays 4).
      unwatch = watchPrincipal(
        principal,
        (err) => {
          open.stop();
          sendError(res, err, opts.onError, metadataUrl);
        },
        { recheckMs: opts.tokenRecheckMs }
      );
      await subscribe(request, open.sink, principal);
    } catch (err) {
      stream?.stop();
      sendError(res, err, opts.onError, metadataUrl);
    } finally {
      unwatch?.();
    }
  };
}

export function createRegistryServer(adapter: Adapter, opts: ServeOptions = {}): Server {
  const handle = handleRequest(adapter, opts);
  return createServer((req, res) => void handle(req, res));
}
