/**
 * The HTTP binding of the source protocol (spec/registry.md @ 4166f34, "Bindings" → "HTTP"):
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
 *
 * Served as HTTP/1.1, which the spec allows ("HTTP/1.1 works"); see `grpc.ts` for why the gRPC
 * binding has its own port.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
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

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

/**
 * A `ProtocolError` is sent as is. Anything else is `unavailable` with a fixed message: its own
 * text can name a database or a host, and this endpoint is public.
 */
function sendError(res: ServerResponse, err: unknown, onError?: (err: unknown) => void) {
  let code: ErrorCode = 'unavailable';
  let message = 'unavailable';
  if (err instanceof ProtocolError) {
    code = err.code;
    message = err.message;
  } else {
    onError?.(err);
  }
  if (res.headersSent) {
    res.end(`event: error\ndata: ${JSON.stringify({ error: code, message })}\n\n`);
  } else {
    sendJson(res, HTTP_STATUS[code], { error: code, message });
  }
}

function openStream(res: ServerResponse, slowConsumerMs: number): EventSink {
  if (res.closed) return { signal: AbortSignal.abort(), send: async () => undefined };
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  res.on('close', () => {
    clearInterval(heartbeat);
    abort.abort();
  });
  let started = false;
  return {
    signal: abort.signal,
    async send(event) {
      if (abort.signal.aborted) return;
      if (!started) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          ...CORS,
        });
        started = true;
        // Armed only once the head is written: a heartbeat before it would send default
        // headers, and the writeHead above would then throw.
        heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
      }
      const flushed = res.write(sseFrame(event));
      if (event.type === 'end') res.end();
      else if (!flushed) await drained(res, abort.signal, slowConsumerMs);
    },
  };
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

export function handleRequest(
  adapter: Adapter,
  opts: { onError?: (err: unknown) => void; slowConsumerMs?: number } = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const subscribe = createSubscriber(adapter);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname !== '/subscribe') {
      return sendError(res, new ProtocolError('bad_request', `no route ${url.pathname}`));
    }
    try {
      const request = subscribeRequest({
        schema: url.searchParams.get('schema'),
        cursor: resumeCursor(req, url.searchParams),
        urns: url.searchParams.getAll('urn'),
        filter: url.searchParams.get('filter'),
      });
      await subscribe(request, openStream(res, opts.slowConsumerMs ?? SLOW_CONSUMER_MS));
    } catch (err) {
      if (!res.writableEnded) sendError(res, err, opts.onError);
    }
  };
}

export function createRegistryServer(
  adapter: Adapter,
  opts: { onError?: (err: unknown) => void } = {}
): Server {
  const handle = handleRequest(adapter, opts);
  return createServer((req, res) => void handle(req, res));
}
