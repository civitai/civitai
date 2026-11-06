/**
 * The one implementation of `Subscribe` (spec/registry.md @ 656ba0a, "Subscribe"), shared by
 * both bindings: `serve.ts` (HTTP/SSE) and `grpc.ts` (gRPC) only translate a request in and
 * events and errors out, so the two cannot drift.
 *
 * In order, for one request:
 *   1. the filter is compiled (`bad_request` for one that is not a schema);
 *   2. a schema this source does not serve is answered `end` first (rule 4), before any cursor
 *      state is read or written;
 *   3. a resume's cursor is checked against the request (rule 2, {@link unbindCursor}), then by
 *      the adapter, all before `live`, so a refused cursor is `cursor_expired` with no event;
 *   4. a snapshot (no cursor) is sent with empty cursors, then `live`, then each change, and a
 *      `progress` whenever the position moves with nothing sent for it (rule 9).
 * An error is thrown; each binding sends it as its own status, or as an error event once the
 * stream has started.
 */
import type { EventEmitter } from 'node:events';
import { createFilterCompiler } from '~/server/registry-adapter/json-schema';
import type { Adapter, StreamEvent, SubscribeRequest } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';

/** Where a subscription's events go: one binding's open stream. */
export type EventSink = {
  /** Aborted when the consumer goes away. */
  signal: AbortSignal;
  /** Resolves once the binding can take the next event (its flow control). */
  send(event: StreamEvent): Promise<void>;
};

const BOUND_CURSOR_RE = /^b1\.([0-9a-f]{24})\.(.+)$/;

/**
 * The request a cursor is tied to (rule 2: "tied to the request's `schema`, `urns` and
 * `filter`"), as a digest. `urns` are a set (sorted, duplicates dropped) and the filter is
 * canonical JSON (keys sorted, array order kept), so neither the order of `urn` parameters nor
 * the key order of a filter changes it.
 */
export function requestBinding(req: Pick<SubscribeRequest, 'schema' | 'urns' | 'filter'>): string {
  const urns = [...new Set(req.urns)].sort();
  return sha256Hex(sortedKeyJson({ schema: req.schema, urns, filter: req.filter ?? null })).slice(
    0,
    24
  );
}

/**
 * The cursor a consumer is handed: the adapter's own cursor, prefixed with the request it was
 * issued for. The binding lives in the cursor rather than in the stored state because the state
 * is per stream and shared by every subscription of the schema, whatever its `urns` or filter
 * (both narrow in this core, after the adapter's diff); binding the state would fork it per
 * filter and multiply the writes. The check also costs no read, and covers the cursors that name
 * no stored state. A forged binding only misleads its own sender, who could have sent the
 * matching request anyway.
 */
export function bindCursor(cursor: string, binding: string): string {
  return `b1.${binding}.${cursor}`;
}

/** The adapter's cursor inside `cursor`, or `cursor_expired` when it was issued for another request. */
export function unbindCursor(cursor: string, binding: string): string {
  const m = BOUND_CURSOR_RE.exec(cursor);
  if (!m) throw cursorExpired('not a cursor this source issued');
  if (m[1] !== binding) {
    throw cursorExpired('the cursor was issued for a different schema, urns or filter');
  }
  return m[2];
}

/**
 * How long a consumer may keep a binding's buffer full before its stream ends with
 * `slow_consumer` (rule 8). A source here never queues: it waits on the binding's flow control,
 * and the poll loops behind it wait with it, so a stalled consumer holds a connection and nothing
 * else.
 */
export const SLOW_CONSUMER_MS = 30_000;

/**
 * Resolves on the emitter's next `drain`, or when `signal` aborts; rejects with `slow_consumer`
 * after `ms`. Both bindings' streams are writables that emit `drain`.
 */
export function drained(
  stream: Pick<EventEmitter, 'once' | 'off'>,
  signal: AbortSignal,
  ms: number = SLOW_CONSUMER_MS
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      stream.off('drain', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(() => {
      stream.off('drain', done);
      signal.removeEventListener('abort', done);
      reject(new ProtocolError('slow_consumer', 'the consumer did not keep up with the stream'));
    }, ms);
    stream.once('drain', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createSubscriber(adapter: Adapter) {
  const compileFilter = createFilterCompiler();

  return async function subscribe(req: SubscribeRequest, sink: EventSink): Promise<void> {
    const { signal } = sink;
    const matches = compileFilter(req.filter) ?? (() => true);
    const ctx = { signal };
    if (!(await adapter.serves(req.schema, ctx))) return sink.send({ type: 'end' });

    const binding = requestBinding(req);
    const bind = (cursor: string) => bindCursor(cursor, binding);
    let position = req.cursor === undefined ? undefined : unbindCursor(req.cursor, binding);
    const wanted = (urn: string) => req.urns.length === 0 || req.urns.includes(urn);

    if (position === undefined) {
      const snapshot = await adapter.snapshot(req.schema, ctx);
      for await (const entity of snapshot.entities) {
        if (signal.aborted) return;
        if (wanted(entity.urn) && matches(entity.body)) {
          await sink.send({ type: 'upsert', entity, cursor: '' });
        }
      }
      position = snapshot.cursor;
    }
    // The cursor is checked before `live`: one the source cannot resume from rejects here, and
    // on a resume nothing has been sent yet, so it is answered with its own status.
    const changes = await adapter.changes(req.schema, position, ctx);
    if (signal.aborted) return;
    let reported = bind(position);
    await sink.send({ type: 'live', cursor: reported });

    // A change this request does not carry (another URN) still moves the position; so does an
    // adapter's own `progress`. Either is reported only when the cursor differs from the last
    // one the consumer was sent.
    const progress = async (cursor: string) => {
      const next = bind(cursor);
      if (next === reported) return;
      reported = next;
      await sink.send({ type: 'progress', cursor: next });
    };
    for await (const change of changes) {
      if (signal.aborted) return;
      if ('progress' in change) {
        await progress(change.progress);
      } else if ('upsert' in change) {
        if (!wanted(change.upsert.urn)) {
          await progress(change.cursor);
          continue;
        }
        reported = bind(change.cursor);
        await sink.send(
          matches(change.upsert.body)
            ? { type: 'upsert', entity: change.upsert, cursor: reported }
            : { type: 'delete', urn: change.upsert.urn, cursor: reported }
        );
      } else if (wanted(change.delete)) {
        reported = bind(change.cursor);
        await sink.send({ type: 'delete', urn: change.delete, cursor: reported });
      } else {
        await progress(change.cursor);
      }
    }
    if (!signal.aborted) await sink.send({ type: 'end' });
  };
}

export type Subscribe = ReturnType<typeof createSubscriber>;
