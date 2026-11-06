/**
 * Snapshot-and-diff over a durable record of what each cursor named.
 *
 * A cursor is the digest of one served set (the `(urn, rev)` pairs of one schema's stream).
 * The set itself is written to a {@link SnapshotStore} before its cursor is handed out, so a
 * resume — in this process or one started later — diffs the current state against exactly what
 * that consumer was last told. That is what makes deletes correct: a listing that left the
 * public catalog (unpublished, kill switch, a visibility change) has no row or timestamp left
 * to notice, but it is still in the stored set, so its absence is a delete. A cursor whose set
 * is gone answers `cursor_expired`, never a silent gap.
 */
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex } from '~/server/registry-adapter/release';
import type { EntitySets } from '~/server/registry-adapter/entities';

export interface SnapshotStore {
  get(digest: string): Promise<string | null>;
  /**
   * Idempotent: the same digest always holds the same value. Makes it the newest state of
   * `stream`, refreshes its retention, and drops that stream's states beyond
   * {@link STATES_KEPT_PER_STREAM} ({@link retainLatest}).
   */
  put(digest: string, value: string, stream: string): Promise<void>;
  /** What `put` does for a state already held, without rewriting its value: on a resume. */
  touch(digest: string, stream: string): Promise<void>;
}

/**
 * States kept per stream. A document stream's state holds every document it served, and a new
 * one is written on every poll that changed something, so without a bound storage grows with
 * polls × documents for the retention period. A cursor older than the newest
 * `STATES_KEPT_PER_STREAM` states of its stream answers `cursor_expired`, and the consumer
 * re-snapshots — the same path as a cursor whose state expired.
 */
export const STATES_KEPT_PER_STREAM = 64;

/** A stream's state list after `digest` becomes its newest, and the digests that fall off it. */
export function retainLatest(
  list: readonly string[],
  digest: string,
  keep: number = STATES_KEPT_PER_STREAM
): { list: string[]; evicted: string[] } {
  const next = [digest, ...list.filter((d) => d !== digest)];
  return { list: next.slice(0, keep), evicted: next.slice(keep) };
}

export const CURSOR_FORMAT = 'c1';
const CURSOR_RE = /^c1\.([0-9a-f]{32})$/;

type ServedSet = { schema: string; entries: Array<[urn: string, rev: string]> };

export function servedSet(schema: string, entities: readonly Entity[]): ServedSet {
  const byUrn = new Map<string, string>();
  for (const e of entities) if (!byUrn.has(e.urn)) byUrn.set(e.urn, e.rev);
  const entries = [...byUrn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { schema, entries };
}

export function cursorFor(set: ServedSet): string {
  const lines = set.entries.map(([urn, rev]) => `${urn}\t${rev}`).join('\n');
  return `${CURSOR_FORMAT}.${sha256Hex(`${CURSOR_FORMAT}\n${set.schema}\n${lines}`).slice(0, 32)}`;
}

/** The changes that take a consumer from `before` to `after`, deletes first, each in URN order. */
export function diffServed(
  before: ReadonlyMap<string, string>,
  after: readonly Entity[]
): Array<{ upsert: Entity } | { delete: string }> {
  const now = new Map<string, Entity>();
  for (const e of after) if (!now.has(e.urn)) now.set(e.urn, e);
  const deletes = [...before.keys()].filter((urn) => !now.has(urn)).sort();
  const upserts = [...now.values()]
    .filter((e) => before.get(e.urn) !== e.rev)
    .sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
  return [...deletes.map((urn) => ({ delete: urn })), ...upserts.map((upsert) => ({ upsert }))];
}

export type PollingAdapterOptions = {
  namespace: string;
  serves: readonly string[];
  /** Every entity, grouped by schema. A throw ends the subscription with `unavailable`. */
  read: () => Promise<EntitySets>;
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
};

export function createPollingAdapter(opts: PollingAdapterOptions): Adapter {
  const current = async (schema: string): Promise<Entity[]> => {
    try {
      const sets = await opts.read();
      return sets.get(schema) ?? [];
    } catch (err) {
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the catalog could not be read');
    }
  };

  const save = async (set: ServedSet): Promise<string> => {
    const cursor = cursorFor(set);
    await opts.store.put(cursor.slice(CURSOR_FORMAT.length + 1), JSON.stringify(set), set.schema);
    return cursor;
  };

  const load = async (schema: string, cursor: string): Promise<Map<string, string>> => {
    const digest = CURSOR_RE.exec(cursor)?.[1];
    if (!digest) throw cursorExpired('not a cursor this source issued');
    const raw = await opts.store.get(digest);
    if (raw === null) throw cursorExpired('the snapshot this cursor names is no longer held');
    let set: ServedSet;
    try {
      set = JSON.parse(raw) as ServedSet;
    } catch {
      throw cursorExpired('the snapshot this cursor names is unreadable');
    }
    if (set.schema !== schema || !Array.isArray(set.entries)) {
      throw cursorExpired('the cursor belongs to another schema');
    }
    await opts.store.touch(digest, schema);
    return new Map(set.entries);
  };

  return {
    namespace: opts.namespace,
    serves: (schema) => opts.serves.includes(schema),

    async snapshot(schema) {
      const entities = await current(schema);
      const set = servedSet(schema, entities);
      const kept = new Set(set.entries.map(([urn]) => urn));
      return {
        cursor: await save(set),
        entities: entities.filter((e) => kept.delete(e.urn)),
      };
    },

    async *changes(schema, cursor, { signal }): AsyncGenerator<Change> {
      let served = await load(schema, cursor);
      let position = cursor;
      while (!signal.aborted) {
        const entities = await current(schema);
        const diff = diffServed(served, entities);
        if (diff.length > 0) {
          const set = servedSet(schema, entities);
          const next = await save(set);
          // Until the last change of a batch, resuming means re-reading the batch from the
          // cursor it started at: repeats are harmless (latest state wins), a gap would not be.
          for (let i = 0; i < diff.length; i++) {
            if (signal.aborted) return;
            const at = i === diff.length - 1 ? next : position;
            const change = diff[i];
            yield 'upsert' in change
              ? { upsert: change.upsert, cursor: at }
              : { delete: change.delete, cursor: at };
          }
          served = new Map(set.entries);
          position = next;
        }
        await opts.sleep(opts.pollMs, signal);
      }
    },
  };
}

/** One read shared by every subscription that asks within `maxAgeMs` of it. */
export function sharedRead<T>(
  read: () => Promise<T>,
  maxAgeMs: number,
  now: () => number = Date.now
): () => Promise<T> {
  let last: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (last && now() - last.at < maxAgeMs) return last.value;
    const value = read();
    const entry = { at: now(), value };
    last = entry;
    value.catch(() => {
      if (last === entry) last = null;
    });
    return value;
  };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
