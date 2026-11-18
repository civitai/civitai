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
 *
 * The app, release and schema streams ({@link RATED_SCHEMAS}) are narrowed per audience, as
 * `audience.ts` describes. Here that is: a served set holds what {@link readableBy} returns for
 * the subscription's audience, records that audience's key ({@link cursorFor} digests it), and is
 * kept under a stream key of its own per audience ({@link streamOf}).
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { contextAudience } from '~/server/registry-adapter/audience';
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex } from '~/server/registry-adapter/release';
import type { EntitySets } from '~/server/registry-adapter/entities';
import { RATED_SCHEMAS, readableBy } from '~/server/registry-adapter/entities';

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
 * States kept per stream, so storage does not grow with polls × documents. A cursor older than
 * these answers `cursor_expired`, as an expired one does.
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

type ServedSet = {
  schema: string;
  /**
   * The {@link Audience} key the set was served to, for a schema narrowed per audience
   * ({@link RATED_SCHEMAS}); absent for one that is the same for every subscription.
   */
  audience?: string;
  entries: Array<[urn: string, rev: string]>;
};

export function servedSet(
  schema: string,
  entities: readonly Entity[],
  audience?: string
): ServedSet {
  const byUrn = new Map<string, string>();
  for (const e of entities) if (!byUrn.has(e.urn)) byUrn.set(e.urn, e.rev);
  const entries = [...byUrn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return audience === undefined ? { schema, entries } : { schema, audience, entries };
}

export function cursorFor(set: ServedSet): string {
  const lines = set.entries.map(([urn, rev]) => `${urn}\t${rev}`).join('\n');
  // An entry line starts with `urn:`, so the audience line can never be read as one. A set of
  // no audience digests as it did before audiences.
  const audience = set.audience === undefined ? '' : `audience ${set.audience}\n`;
  return `${CURSOR_FORMAT}.${sha256Hex(
    `${CURSOR_FORMAT}\n${set.schema}\n${audience}${lines}`
  ).slice(0, 32)}`;
}

/** The stream a set's states are kept under: per audience for a narrowed schema. */
const streamOf = (set: Pick<ServedSet, 'schema' | 'audience'>) =>
  set.audience === undefined ? set.schema : `${set.schema}#${set.audience}`;

/** The audience key a stream of `schema` is bound to, or undefined for an unnarrowed schema. */
const boundAudience = (schema: string, audience: Audience): string | undefined =>
  RATED_SCHEMAS.has(schema) ? audience.key : undefined;

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
  /**
   * Every entity, grouped by schema. A throw ends the subscription with `unavailable`. The sets
   * returned are never changed afterwards, and returning the same object to every poll of one
   * catalog read (`buildEntitiesPerRead`) lets them share the narrowing ({@link createReadableMemo}).
   */
  read: () => Promise<EntitySets>;
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
};

/**
 * Narrowed entity lists kept per read of the entity sets. A set object is never changed once
 * read, so `(sets, schema, audience.key)` always narrows to the same list.
 */
export const NARROWED_KEPT_PER_READ = 32;

/**
 * {@link readableBy}, computed once per `(sets, schema, audience)`, so subscriptions polling one
 * shared read (`buildEntitiesPerRead`) with the same audience get the same list. The lists are
 * shared across subscriptions: callers must not change them.
 */
export function createReadableMemo(): (
  sets: EntitySets,
  schema: string,
  audience: Audience
) => Entity[] {
  const memo = new WeakMap<EntitySets, Map<string, Entity[]>>();
  return (sets, schema, audience) => {
    let lists = memo.get(sets);
    if (!lists) memo.set(sets, (lists = new Map()));
    const key = `${schema}\n${audience.key}`;
    let list = lists.get(key);
    if (!list) {
      if (lists.size >= NARROWED_KEPT_PER_READ) lists.clear();
      list = readableBy(sets, schema, audience);
      lists.set(key, list);
    }
    return list;
  };
}

export function createPollingAdapter(opts: PollingAdapterOptions): Adapter {
  const narrow = createReadableMemo();
  /** What `audience` may read of `schema` now. */
  const current = async (schema: string, audience: Audience): Promise<Entity[]> => {
    let sets: EntitySets;
    try {
      sets = await opts.read();
    } catch (err) {
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the catalog could not be read');
    }
    return narrow(sets, schema, audience);
  };

  const save = async (set: ServedSet): Promise<string> => {
    const cursor = cursorFor(set);
    await opts.store.put(
      cursor.slice(CURSOR_FORMAT.length + 1),
      JSON.stringify(set),
      streamOf(set)
    );
    return cursor;
  };

  const load = async (
    schema: string,
    cursor: string,
    audience: string | undefined
  ): Promise<Map<string, string>> => {
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
    // Checked before anything in the set is used: a resume diffs against its entries, and its
    // deletes would name entities this audience may not read.
    if (set.audience !== audience) {
      throw cursorExpired('the cursor was issued to a token that may read different ratings');
    }
    await opts.store.touch(digest, streamOf(set));
    return new Map(set.entries);
  };

  /** The changes after a cursor already loaded: what `changes` resolves to. */
  async function* follow(
    schema: string,
    cursor: string,
    loaded: Map<string, string>,
    signal: AbortSignal,
    audience: Audience
  ): AsyncGenerator<Change> {
    let served = loaded;
    let position = cursor;
    while (!signal.aborted) {
      const entities = await current(schema, audience);
      const diff = diffServed(served, entities);
      if (diff.length > 0) {
        const set = servedSet(schema, entities, boundAudience(schema, audience));
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
  }

  return {
    namespace: opts.namespace,
    // The served set is the whole schema's (as the audience may read it), so its cursor moves
    // only with a change: this adapter never yields `progress`. A subscription narrowed by `urns`
    // still gets one, from the core.
    serves: (schema) => opts.serves.includes(schema),

    async snapshot(schema, ctx) {
      const audience = contextAudience(ctx);
      const entities = await current(schema, audience);
      const set = servedSet(schema, entities, boundAudience(schema, audience));
      const kept = new Set(set.entries.map(([urn]) => urn));
      return {
        cursor: await save(set),
        entities: entities.filter((e) => kept.delete(e.urn)),
      };
    },

    async changes(schema, cursor, ctx) {
      const audience = contextAudience(ctx);
      const served = await load(schema, cursor, boundAudience(schema, audience));
      return follow(schema, cursor, served, ctx.signal, audience);
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
