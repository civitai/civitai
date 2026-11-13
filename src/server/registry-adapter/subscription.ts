/**
 * The one implementation of `Subscribe` (the registry spec, "Subscribe"), shared by
 * both bindings: `serve.ts` (HTTP/SSE) and `grpc.ts` (gRPC) only translate a request in and
 * events and errors out, so the two cannot drift.
 *
 * In order, for one request:
 *   1. the filter is compiled (`bad_request` for one that is not a schema, or one this source
 *      will not evaluate: rule 6, a filter is applied in full or refused, never ignored);
 *   2. a request this source can never serve anything for is answered `end` first (rule 4),
 *      before any cursor state is read or written: a schema it has no source for
 *      (`Adapter.serves`: `end` means never), or `urns` none of which is of its namespace
 *      ({@link servesAnyUrn});
 *   3. a resume's cursor is checked against the request and the token's subject (rule 2, the
 *      auth extension; {@link unbindCursor}), then by the adapter, which for a document, app,
 *      release or schema stream also checks the token's audience, all before `live`, so a refused cursor is
 *      `cursor_expired` with no event;
 *   4. a snapshot (no cursor) is sent with empty cursors, since a snapshot cannot be continued
 *      (rule 2), then `live`, then each change, and a `progress` whenever the position moves
 *      with nothing sent for it (rule 9): a change of another URN, a change the filter excluded,
 *      or the adapter's own `progress`.
 * An error is thrown; each binding sends it as its own status, or as an error event once the
 * stream has started.
 */
import type { EventEmitter } from 'node:events';
import type { Principal } from '~/server/registry-adapter/auth';
import { ANONYMOUS_PRINCIPAL } from '~/server/registry-adapter/auth';
import { createFilterCompiler } from '~/server/registry-adapter/json-schema';
import type { Adapter, StreamEvent, SubscribeRequest } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { urnNamespace } from '~/server/registry-adapter/urn';

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
export function requestBinding(
  req: Pick<SubscribeRequest, 'schema' | 'urns' | 'filter'>,
  subject: string | null = null
): string {
  const urns = [...new Set(req.urns)].sort();
  return sha256Hex(
    sortedKeyJson({
      schema: req.schema,
      urns,
      filter: req.filter ?? null,
      // The auth extension ties an authorized stream's cursor to its token's subject. Anonymous
      // adds nothing, so its bindings are what they were before tokens.
      ...(subject !== null ? { subject } : {}),
    })
  ).slice(0, 24);
}

/**
 * The cursor a consumer is handed: the adapter's own cursor, prefixed with the request it was
 * issued for. The binding lives in the cursor rather than in the stored state because the state
 * is per stream and shared by every subscription of the schema, whatever its `urns` or filter
 * (both narrow in this core, after the adapter's diff); binding the state would fork it per
 * filter and multiply the writes. The check also costs no read, and covers the cursors that name
 * no stored state. A forged binding only misleads its own sender, who could have sent the
 * matching request anyway.
 *
 * The binding is a public digest, so it is not what keeps one token's view from another: a
 * holder of someone else's cursor can re-bind it. What does is that the stored state of a stream
 * narrowed per audience (a document stream, `doc-feed.ts`; an app, release or schema stream,
 * `cursor.ts`) names the audience it was served to, and a resume by another audience is
 * `cursor_expired` before anything is read from that state. The one other entity stream
 * (`service`) is the same for every principal, so re-binding its cursor gains nothing.
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
 * `slow_consumer` (rule 8).
 *
 * Before that, a consumer that falls behind is sent the latest state, not every superseded event
 * (rule 8): the next poll diffs against what it was last sent. `slow_consumer` is for a consumer
 * that takes nothing for this long; it frees the connection, and the consumer resumes from its
 * cursor.
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

/**
 * Whether a request's `urns` leave this source anything to serve: no `urns` (every entity), or at
 * least one of the adapter's namespace. Rule 4 answers `end` for `urns` outside the registry's
 * namespaces, since only its origin ever sends a namespace's entities (rule 3). A request naming
 * some URNs of this namespace and some of another is served: rule 5 streams "a snapshot of those
 * that exist", the foreign ones never do here, and rule 4 forbids `end` for a request this source
 * may serve later, which the in-namespace URNs are.
 */
export function servesAnyUrn(urns: readonly string[], namespace: string): boolean {
  return urns.length === 0 || urns.some((urn) => urnNamespace(urn) === namespace);
}

export function createSubscriber(adapter: Adapter) {
  const compileFilter = createFilterCompiler();

  return async function subscribe(
    req: SubscribeRequest,
    sink: EventSink,
    principal: Principal = ANONYMOUS_PRINCIPAL
  ): Promise<void> {
    const { signal } = sink;
    const filter = compileFilter(req.filter);
    const matches = filter ?? (() => true);
    const ctx = { signal, audience: principal.audience };
    if (!adapter.serves(req.schema)) return sink.send({ type: 'end' });
    if (!servesAnyUrn(req.urns, adapter.namespace)) return sink.send({ type: 'end' });

    const binding = requestBinding(req, principal.subject);
    const bind = (cursor: string) => bindCursor(cursor, binding);
    let position = req.cursor === undefined ? undefined : unbindCursor(req.cursor, binding);
    const wanted = (urn: string) => req.urns.length === 0 || req.urns.includes(urn);
    // The URNs this consumer holds, when a filter applies and this connection sent the snapshot:
    // then a change to an entity the consumer never received, and that still does not match, is
    // excluded (only a `progress`) rather than sent as a `delete`. On a resume what the consumer
    // holds is unknown, so a non-matching change is a `delete`, which rule 7 allows; either way
    // the consumer's cursor keeps up with the position.
    const held = filter && position === undefined ? new Set<string>() : null;

    if (position === undefined) {
      const snapshot = await adapter.snapshot(req.schema, ctx);
      for await (const entity of snapshot.entities) {
        if (signal.aborted) return;
        if (wanted(entity.urn) && matches(entity.body)) {
          held?.add(entity.urn);
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
        const { urn } = change.upsert;
        if (!wanted(urn)) {
          await progress(change.cursor);
        } else if (matches(change.upsert.body)) {
          held?.add(urn);
          reported = bind(change.cursor);
          await sink.send({ type: 'upsert', entity: change.upsert, cursor: reported });
        } else if (held && !held.has(urn)) {
          await progress(change.cursor);
        } else {
          // It stopped matching (rule 6), or what the consumer holds is unknown.
          held?.delete(urn);
          reported = bind(change.cursor);
          await sink.send({ type: 'delete', urn, cursor: reported });
        }
      } else if (!wanted(change.delete) || (held && !held.has(change.delete))) {
        await progress(change.cursor);
      } else {
        held?.delete(change.delete);
        reported = bind(change.cursor);
        await sink.send({ type: 'delete', urn: change.delete, cursor: reported });
      }
    }
    if (!signal.aborted) await sink.send({ type: 'end' });
  };
}

export type Subscribe = ReturnType<typeof createSubscriber>;
