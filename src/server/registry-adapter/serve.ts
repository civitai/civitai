/**
 * The HTTP/SSE binding of the source protocol, matching the registry SDK's `serve()`: one
 * route, `GET /subscribe`, plus `/healthz` for a process supervisor.
 *
 * A request's `filter` is applied as the SDK applies it: a snapshot entity that does not match
 * is left out, and a change that stops matching is sent as a delete. A filter this source will
 * not evaluate (too large, or using a regular expression) is not applied; the registry still is.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createFilterCompiler } from '~/server/registry-adapter/json-schema';
import type { Adapter, ErrorCode, StreamEvent } from '~/server/registry-adapter/protocol';
import {
  HTTP_STATUS,
  ProtocolError,
  parseSubscribeQuery,
  sseFrame,
} from '~/server/registry-adapter/protocol';

const HEARTBEAT_MS = 15_000;
const CORS = { 'access-control-allow-origin': '*' };

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

function openStream(req: IncomingMessage, res: ServerResponse) {
  if (res.closed) return { signal: AbortSignal.abort(), send: () => undefined };
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  res.on('close', () => {
    clearInterval(heartbeat);
    abort.abort();
  });
  let started = false;
  return {
    signal: abort.signal,
    send(event: StreamEvent) {
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
      res.write(sseFrame(event));
      if (event.type === 'end') res.end();
    },
  };
}

export function handleRequest(
  adapter: Adapter,
  opts: { onError?: (err: unknown) => void } = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compileFilter = createFilterCompiler();
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname !== '/subscribe') {
      return sendError(res, new ProtocolError('bad_request', `no route ${url.pathname}`));
    }
    try {
      const { schema, cursor, urns, filter } = parseSubscribeQuery(url.searchParams);
      const matches = compileFilter(filter) ?? (() => true);
      const stream = openStream(req, res);
      if (!adapter.serves(schema)) return stream.send({ type: 'end' });
      const wanted = (urn: string) => urns.length === 0 || urns.includes(urn);
      const ctx = { signal: stream.signal };

      let position = cursor;
      if (!position) {
        const snapshot = await adapter.snapshot(schema, ctx);
        for await (const entity of snapshot.entities) {
          if (stream.signal.aborted) return;
          if (wanted(entity.urn) && matches(entity.body))
            stream.send({ type: 'upsert', entity, cursor: '' });
        }
        position = snapshot.cursor;
      }
      // The cursor is checked before `live`: one the source cannot resume from rejects here, and
      // on a resume nothing has been sent yet, so it is answered with its own status.
      const changes = await adapter.changes(schema, position, ctx);
      if (stream.signal.aborted) return;
      stream.send({ type: 'live', cursor: position });

      for await (const change of changes) {
        if (stream.signal.aborted) return;
        if ('upsert' in change) {
          if (wanted(change.upsert.urn)) {
            stream.send(
              matches(change.upsert.body)
                ? { type: 'upsert', entity: change.upsert, cursor: change.cursor }
                : { type: 'delete', urn: change.upsert.urn, cursor: change.cursor }
            );
          }
        } else if (wanted(change.delete)) {
          stream.send({ type: 'delete', urn: change.delete, cursor: change.cursor });
        }
      }
      if (!stream.signal.aborted) stream.send({ type: 'end' });
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
