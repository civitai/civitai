/**
 * The shared-document feed: one stream per collection major
 * (`urn:schema:app-blocks:<slug>/<coll>@vN`), carrying every visible shared document of that
 * collection that satisfies the major. Each document claims every major of its collection it
 * satisfies, so a mint brings unchanged documents into the new major's stream.
 *
 * A cursor is the digest of the stream's state — the app it was read from, the seq position, the
 * collection's schemas, a witness document and every (urn, rev) served — and that state is written
 * to the {@link SnapshotStore} before the cursor is handed out. So the seq never appears in a
 * cursor (private writes share it, and a raw seq would tell their volume), a resume diffs against
 * exactly what the consumer was told, and an app that leaves the public set has its documents
 * deleted from that record, with no tombstone needed.
 *
 * `cursor_expired` when the stream's history cannot be trusted any more: the slug now names a
 * different app (re-created), the namespace's seq is behind the cursor's (reset), or the witness
 * — the newest document the cursor served — has neither a document nor a tombstone at or past the
 * seq it was served at (purged and written again).
 *
 * A collection major that does not resolve now (unknown app or collection, not exported, not
 * minted, the switch off) may still be published later, so it is served, empty: a snapshot of
 * nothing and `live` with {@link EMPTY_CURSOR}, writing no state. The stream keeps polling, and
 * once the major resolves its documents arrive on it as upserts. (`end` would mean never.)
 *
 * After `live`, a poll that finds the namespace's seq moved with no change for this stream (a
 * private write, another collection) yields `progress` with the new cursor (spec rule 9), so a
 * consumer's cursor follows the position instead of naming an ever older one.
 */
import type { ValidateFunction } from 'ajv';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { newValidator } from '~/server/registry-adapter/json-schema';
import type { AdapterContext, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';
import { sortedKeyJson, sha256Hex } from '~/server/registry-adapter/release';
import { registryUrn } from '~/server/registry-adapter/urn';

export type FeedDocument = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
};

/** The reads the feed makes, all of one app's production namespace, shared documents only. */
export type SharedDocSource = {
  head(appId: string): Promise<number>;
  changes(
    appId: string,
    coll: string,
    after: number,
    upTo: number,
    limit: number
  ): Promise<{
    docs: Array<FeedDocument & { hidden: boolean }>;
    tombs: Array<{ key: string; seq: number }>;
  }>;
  documents(
    appId: string,
    coll: string,
    afterKey: string,
    upTo: number,
    limit: number
  ): Promise<FeedDocument[]>;
  witness(
    appId: string,
    coll: string,
    key: string
  ): Promise<{ docSeq: number | null; tombSeq: number | null }>;
};

/** A collection major that is published now: its app, and every major of the collection. */
export type CollectionStream = {
  appId: string;
  slug: string;
  collection: string;
  /** Every major's schema document, `@v1` first. */
  family: Array<{ urn: string; body: Record<string, unknown> }>;
};

/** The published collection a stream schema names, or null when it is not published now. */
export type ResolveStream = (schema: string) => Promise<CollectionStream | null>;

export const FEED_PAGE = 500;
const STATE_FORMAT = 'f1';
/**
 * The cursor of a stream that holds nothing for no app; it names no stored state. So a
 * subscription to a collection major that is not published (or invented) writes nothing.
 */
export const EMPTY_CURSOR = `${STATE_FORMAT}.empty`;
const CURSOR_RE = /^f1\.([0-9a-f]{32})$/;

type Served = { rev: string; seq: number };
type FeedState = {
  v: typeof STATE_FORMAT;
  schema: string;
  appId: string | null;
  seq: number;
  family: string | null;
  witness: { key: string; seq: number } | null;
  served: Array<[urn: string, rev: string, seq: number]>;
};

// The claim set is part of the rev: a mint that makes a document claim one more major changes
// it, so every stream that carries the document re-sends it with its new label set.
const docRev = (d: FeedDocument, schemas: readonly string[]) =>
  sha256Hex(sortedKeyJson({ version: d.version, data: d.data, schemas })).slice(0, 16);

const emptyState = (schema: string): FeedState => ({
  v: STATE_FORMAT,
  schema,
  appId: null,
  seq: 0,
  family: null,
  witness: null,
  served: [],
});

/**
 * Validators for one collection's family, compiled once per distinct family. A document claims
 * every major whose schema it satisfies.
 */
export function createClaimer(maxFamilies = 200) {
  const cache = new Map<string, Array<{ urn: string; validate: ValidateFunction }>>();
  return (family: CollectionStream['family'], digest: string) => {
    let validators = cache.get(digest);
    if (!validators) {
      if (cache.size >= maxFamilies) cache.clear();
      const ajv = newValidator();
      validators = family.map(({ urn, body }) => ({ urn, validate: ajv.compile(body) }));
      cache.set(digest, validators);
    }
    const compiled = validators;
    return (data: unknown) => compiled.filter((v) => v.validate(data) === true).map((v) => v.urn);
  };
}

export function familyDigest(family: CollectionStream['family']): string {
  return sha256Hex(sortedKeyJson(family)).slice(0, 32);
}

export type DocFeedOptions = {
  source: SharedDocSource;
  resolve: ResolveStream;
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
};

export function createDocFeed(opts: DocFeedOptions) {
  const claimer = createClaimer();

  const save = async (state: FeedState): Promise<string> => {
    // A stream of no app serving nothing needs no record: its cursor is a constant. So a
    // subscription to an unpublished (or invented) collection URN writes nothing.
    if (state.appId === null && state.served.length === 0) return EMPTY_CURSOR;
    const raw = sortedKeyJson(state);
    const digest = sha256Hex(raw).slice(0, 32);
    await opts.store.put(digest, raw, state.schema);
    return `${STATE_FORMAT}.${digest}`;
  };

  const load = async (schema: string, cursor: string): Promise<FeedState> => {
    if (cursor === EMPTY_CURSOR) return emptyState(schema);
    const digest = CURSOR_RE.exec(cursor)?.[1];
    if (!digest) throw cursorExpired('not a cursor this source issued');
    const raw = await opts.store.get(digest);
    if (raw === null) throw cursorExpired('the state this cursor names is no longer held');
    let state: FeedState;
    try {
      state = JSON.parse(raw) as FeedState;
    } catch {
      throw cursorExpired('the state this cursor names is unreadable');
    }
    if (state.v !== STATE_FORMAT || state.schema !== schema) {
      throw cursorExpired('the cursor belongs to another stream');
    }
    await opts.store.touch(digest, schema);
    return state;
  };

  /** Every visible document of the collection at or below `upTo`, paged by key. */
  async function readAll(appId: string, coll: string, upTo: number): Promise<FeedDocument[]> {
    const out: FeedDocument[] = [];
    let after = '';
    for (;;) {
      const page = await opts.source.documents(appId, coll, after, upTo, FEED_PAGE);
      out.push(...page);
      if (page.length < FEED_PAGE) return out;
      after = page[page.length - 1].key;
    }
  }

  /**
   * The newest event of each key in the seq range (`after`, `upTo`]: the document as written
   * (null when it was deleted or hidden). Pages through documents and tombstones together, so
   * a key's events are always compared in seq order.
   */
  async function readChanged(
    appId: string,
    coll: string,
    after: number,
    upTo: number
  ): Promise<Map<string, FeedDocument | null>> {
    const latest = new Map<string, { seq: number; doc: FeedDocument | null }>();
    const note = (key: string, seq: number, doc: FeedDocument | null) => {
      const at = latest.get(key);
      if (!at || at.seq < seq) latest.set(key, { seq, doc });
    };
    let from = after;
    while (from < upTo) {
      const page = await opts.source.changes(appId, coll, from, upTo, FEED_PAGE);
      // A full page may stop short of a later event of the other kind, so only the range both
      // pages cover is settled.
      let frontier = upTo;
      if (page.docs.length === FEED_PAGE)
        frontier = Math.min(frontier, page.docs[page.docs.length - 1].seq);
      if (page.tombs.length === FEED_PAGE)
        frontier = Math.min(frontier, page.tombs[page.tombs.length - 1].seq);
      for (const d of page.docs) {
        if (d.seq > frontier) continue;
        const { hidden, ...doc } = d;
        note(d.key, d.seq, hidden ? null : doc);
      }
      for (const t of page.tombs) if (t.seq <= frontier) note(t.key, t.seq, null);
      from = frontier;
    }
    return new Map([...latest].map(([key, { doc }]) => [key, doc]));
  }

  /** The stream's state now, from `prev` (null for a snapshot), and the entities to upsert. */
  async function advance(
    schema: string,
    prev: FeedState | null
  ): Promise<{ next: FeedState; entities: Map<string, Entity> }> {
    const stream = await opts.resolve(schema);
    if (!stream) {
      return { next: emptyState(schema), entities: new Map() };
    }
    const { appId, slug, collection, family } = stream;
    if (prev?.appId && prev.appId !== appId) {
      throw cursorExpired('the collection now belongs to a different app');
    }
    const head = await opts.source.head(appId);
    const same = prev !== null && prev.appId === appId;
    if (same && head < prev.seq) throw cursorExpired('the namespace seq went back');
    if (same && prev.witness) {
      const w = await opts.source.witness(appId, collection, prev.witness.key);
      const since = prev.witness.seq;
      if (!((w.docSeq ?? -1) >= since || (w.tombSeq ?? -1) >= since)) {
        throw cursorExpired('a document this cursor served is gone without a trace');
      }
    }

    const digest = familyDigest(family);
    // Nothing written since, and the same schemas: the state is unchanged. Returning it as is
    // skips rebuilding the served set (and `changes` skips the diff).
    if (same && head === prev.seq && prev.family === digest) {
      return { next: prev, entities: new Map() };
    }
    const claims = claimer(family, digest);
    const entityOf = (d: FeedDocument): Entity | null => {
      const schemas = claims(d.data);
      if (!schemas.includes(schema)) return null;
      return {
        urn: registryUrn({ kind: 'document', slug, collection, key: d.key }),
        schemas,
        rev: docRev(d, schemas),
        body: d.data,
      };
    };

    const served = new Map<string, Served>();
    const entities = new Map<string, Entity>();
    const keep = (d: FeedDocument) => {
      const e = entityOf(d);
      if (!e) return;
      served.set(e.urn, { rev: e.rev, seq: d.seq });
      entities.set(e.urn, e);
    };

    // A full read when the stream is new to this app or its schemas changed; otherwise only what
    // changed since the recorded seq, served or not.
    const full = !same || prev.family !== digest;
    if (full) {
      for (const d of await readAll(appId, collection, head)) keep(d);
    } else {
      for (const [urn, rev, seq] of prev.served) served.set(urn, { rev, seq });
      for (const [key, doc] of await readChanged(appId, collection, prev.seq, head)) {
        served.delete(registryUrn({ kind: 'document', slug, collection, key }));
        if (doc) keep(doc);
      }
    }

    let witness: FeedState['witness'] = null;
    for (const [urn, s] of served) {
      if (!witness || s.seq > witness.seq)
        witness = { key: urn.slice(urn.lastIndexOf('/') + 1), seq: s.seq };
    }
    return {
      next: {
        v: STATE_FORMAT,
        schema,
        appId,
        // Recorded even when nothing is served, so an empty stream reads incrementally.
        seq: head,
        family: digest,
        witness,
        served: [...served]
          .map(([urn, s]) => [urn, s.rev, s.seq] as [string, string, number])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      },
      entities,
    };
  }

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the document feed could not be read');
    }
  };

  /** The changes after a loaded `state`, starting from its first poll, `first`, already made. */
  async function* follow(
    schema: string,
    cursor: string,
    loaded: FeedState,
    first: Awaited<ReturnType<typeof advance>>,
    signal: AbortSignal
  ): AsyncGenerator<Change> {
    let state = loaded;
    let position = cursor;
    let pending: Awaited<ReturnType<typeof advance>> | null = first;
    while (!signal.aborted) {
      const before = state;
      const { next, entities } = pending ?? (await guarded(() => advance(schema, before)));
      pending = null;
      if (next === before) {
        await opts.sleep(opts.pollMs, signal);
        continue;
      }
      const was = new Map(before.served.map(([urn, rev]) => [urn, rev]));
      const still = new Set(next.served.map(([urn]) => urn));
      const deletes = [...was.keys()]
        .filter((urn) => !still.has(urn))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const upserts = next.served
        .filter(([urn, rev]) => was.get(urn) !== rev)
        .map(([urn]) => entities.get(urn))
        .filter((e): e is Entity => e !== undefined);
      const diff: Array<{ delete: string } | { upsert: Entity }> = [
        ...deletes.map((urn) => ({ delete: urn })),
        ...upserts.map((upsert) => ({ upsert })),
      ];
      const nextCursor = await save(next);
      if (diff.length > 0) {
        for (let i = 0; i < diff.length; i++) {
          if (signal.aborted) return;
          const at = i === diff.length - 1 ? nextCursor : position;
          const c = diff[i];
          yield 'upsert' in c ? { upsert: c.upsert, cursor: at } : { delete: c.delete, cursor: at };
        }
      } else if (nextCursor !== position) {
        // The seq moved and nothing of this stream changed: the new state is saved, so its
        // cursor resumes from here.
        yield { progress: nextCursor };
      }
      position = nextCursor;
      state = next;
      await opts.sleep(opts.pollMs, signal);
    }
  }

  return {
    async snapshot(schema: string) {
      const { next, entities } = await guarded(() => advance(schema, null));
      return { cursor: await save(next), entities: [...entities.values()] };
    },

    /**
     * Resolves only once the cursor is checked, which here takes the first poll as well: the
     * history checks of {@link advance} (a re-created app, a seq reset, a purge) are cursor
     * checks too, so each of them rejects before `live` rather than after it.
     */
    async changes(schema: string, cursor: string, { signal }: AdapterContext) {
      const state = await guarded(() => load(schema, cursor));
      const first = await guarded(() => advance(schema, state));
      return follow(schema, cursor, state, first, signal);
    },
  };
}
