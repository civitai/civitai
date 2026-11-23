/**
 * SHARED-COLLECTION LEVEL STREAMS (`apps/app-data-go/WRITES-DESIGN.md`, "The shape: one stream per
 * level bit, one small stream per viewer"): the documents of one shared collection major, split by
 * content level, read by app-data-go under its own service identity and shared by every viewer.
 *
 * OFF unless `REGISTRY_ADAPTER_SHARED_LEVEL_CLIENTS` names a client ({@link parseSharedLevelClients});
 * until then no subscription is routed here and every document stream is served as before.
 *
 * ROUTING ("Feed routing"). A subscription is a level stream exactly when ALL hold
 * ({@link isLevelSubscription}): its schema is a collection-schema URN, its token is a SERVICE
 * token (a client as itself, no user) of a client on the shared-level allowlist, and its `meta`
 * names a level ({@link parseLevel}): `level` is one of the five selectable NsfwLevel bits
 * (1 PG, 2 PG-13, 4 R, 8 X, 16 XXX), `"none"` or `"counters"`. Anything else, a token-bearing relay
 * on an exported collection included, is routed as it was before this file existed.
 *
 * WHAT EACH STREAM HOLDS:
 *   - a BIT stream: the collection's visible documents rated, for their current version, at
 *     exactly that bit (`SQL_LEVEL_DOCS_*_BIT`, through THE level predicate with no viewer). A
 *     rated document has one bit, so the five streams partition the rated board; an unrated,
 *     pending or stale-rated document, and a Blocked one, is on none of them;
 *   - `none`: every visible document but counter documents, served only while content levels are
 *     OFF for the app (`app-blocks-shared-doc-levels`; an unreadable flag counts as ON);
 *   - `counters`: the counter documents (`author_kind = 'counter'`), whatever the mode.
 * Each entity is the document's body, its storage `key` and `seq`, its `version`, `createdAt`,
 * `updatedAt` and `tallies` (counters and mark counts, a report count never: the store presents
 * them, `presentTallies`). Never its author, anyone's marks, or an unrated document. Its URN is
 * the shared document's key URN, as the public document feed's (`app-record.ts`). A delete, a
 * moderator hide (a tombstone) and a re-rating off the bit arrive as `Delete`; a re-rating onto
 * the bit, and any write or tally change of a document on it, as `Upsert`.
 *
 * MODE. Every `live` and `progress` names `levels: "on" | "off"` and the slug's approved
 * production block (`block`, the app's store id: app-data-go's signed-out path checks a block
 * token's `appBlockId` against it). A `none` subscription is refused while levels are on, before
 * any snapshot, with an `end` whose meta is `{ reason: "levels_on" }`, and a live one is ended so
 * when they turn on; a bit stream likewise with `levels_off`. A collection that does not resolve
 * now (no approved app, not a shared collection, the major not minted) ends `not_resolved`,
 * never an empty stream that reads as an empty board.
 *
 * POLL ("Poll shapes and cost"). The heads are read FIRST, before any row: the document head
 * (`usage_app.last_seq`) and the mark head (`appdata.mark_head`). Then the `seq` range on `doc`
 * and `doc_tomb` since the stream's last position (the shared feed's shape), and, only when the
 * mark head moved, the mark-sequence range on the collection's tally rows (`doc_tally.mark_seq`),
 * whose keys are re-read as they stand now. Every write at or below a head had committed when it
 * was read, so it is in what the poll read; a head read after the rows could name a write they
 * missed. Where the store has no mark sequence yet (its migration not applied, `markSeq` null)
 * no mark range is read and `head.markSeq` is omitted: a tally change then reaches the stream
 * only with the document's next write. The heads go out in `meta` ({@link headMeta}) on `live`
 * (the state the cursor names) and on a `progress` after each poll whose heads moved.
 *
 * BOUND ("Size, count and alert"). A stream holds at most `maxRecords` documents, strictly above
 * the app's own 2,000-row read ({@link MIN_LEVEL_STREAM_RECORDS}): past it, its NEWEST documents by
 * key (keys sort as the store's `COLLATE "C"`). A delete or re-rating inside the window backfills
 * the next-newest from beyond it. Each poll reports its fill ({@link LevelStreamFill}) for the 75%
 * alert.
 *
 * BINDINGS. A stored state names its schema, its level, its levels mode, its token subject and its
 * bound. A resume whose `meta` names another level, by another subject, or (for `counters`) in
 * another mode is `cursor_expired` before anything else in the state is used; a resume of a bit or
 * `none` stream in a mode it cannot be served in is ended with its reason, as a snapshot is.
 */
import type { Registry } from 'prom-client';
import { Gauge } from 'prom-client';
import type { Audience } from '~/server/registry-adapter/audience';
import { audienceAdmits, contextAudience } from '~/server/registry-adapter/audience';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createClaimer, docRev, familyDigest } from '~/server/registry-adapter/doc-feed';
import { headMeta } from '~/server/registry-adapter/private-feed';
import type { AdapterContext, Change, Entity, EventMeta } from '~/server/registry-adapter/protocol';
import { ProtocolError, StreamEnd, cursorExpired } from '~/server/registry-adapter/protocol';
import { sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { parseCollectionSchemaUrn, registryUrn } from '~/server/registry-adapter/urn';
import type {
  DeclaredTallies,
  LevelChangesPage,
  LevelSelector,
  LevelStreamDocument,
} from '~/server/services/apps/doc-store';

/** The five selectable level bits (PG, PG-13, R, X, XXX), as a level stream's `meta.level`. */
export const LEVEL_BITS = [1, 2, 4, 8, 16] as const;

/** What a level subscription's `meta.level` names: one bit, `none` or `counters`. */
export type LevelName = (typeof LEVEL_BITS)[number] | 'none' | 'counters';

/**
 * The level a request's `meta` names, or null when it names none this feed serves: `level` must
 * be exactly one of {@link LEVEL_BITS} (a JSON number) or the string `none` or `counters`.
 */
export function parseLevel(meta: AdapterContext['meta']): LevelName | null {
  const level = meta?.level;
  if (level === 'none' || level === 'counters') return level;
  return typeof level === 'number' && (LEVEL_BITS as readonly number[]).includes(level)
    ? (level as LevelName)
    : null;
}

/**
 * The clients whose service tokens may read level streams (`REGISTRY_ADAPTER_SHARED_LEVEL_CLIENTS`):
 * OAuth client ids, separated by commas or whitespace. Unset or empty (the default) is the empty
 * set: no level stream exists. Its values live in deploy configuration, never here.
 */
export function parseSharedLevelClients(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(/[\s,]+/).filter(Boolean));
}

/** A service token (no user) of a client on `clients`. */
export function isLevelClient(
  clients: ReadonlySet<string>,
  reader: AdapterContext['reader']
): boolean {
  return !!reader && reader.userId === null && clients.has(reader.clientId);
}

/** Whether a subscription is a level stream (see the file comment's ROUTING). */
export function isLevelSubscription(
  clients: ReadonlySet<string>,
  schema: string,
  ctx: Pick<AdapterContext, 'reader' | 'meta'>
): boolean {
  return (
    parseCollectionSchemaUrn(schema) !== null &&
    isLevelClient(clients, ctx.reader) &&
    parseLevel(ctx.meta) !== null
  );
}

/**
 * The app's own read is at most 2,000 board rows ("The bound is at least the app's own read"), so
 * a level stream's bound must be strictly above it.
 */
export const MIN_LEVEL_STREAM_RECORDS = 2_000;
/** The default bound: strictly above {@link MIN_LEVEL_STREAM_RECORDS}, with headroom. */
export const DEFAULT_LEVEL_STREAM_RECORDS = 2_500;

/**
 * `REGISTRY_ADAPTER_LEVEL_STREAM_MAX_RECORDS`: an integer strictly above
 * {@link MIN_LEVEL_STREAM_RECORDS}; unset or empty is {@link DEFAULT_LEVEL_STREAM_RECORDS}.
 * Anything else refuses to start.
 */
export function parseLevelStreamMaxRecords(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LEVEL_STREAM_RECORDS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= MIN_LEVEL_STREAM_RECORDS) {
    throw new Error(
      `REGISTRY_ADAPTER_LEVEL_STREAM_MAX_RECORDS must be an integer above ${MIN_LEVEL_STREAM_RECORDS}`
    );
  }
  return n;
}

/** A shared collection major that resolves now, with what a level stream needs of it. */
export type SharedLevelCollection = Pick<
  CollectionStream,
  'appId' | 'slug' | 'collection' | 'contentRating' | 'family'
> & {
  /** The slug's approved production block id, which `live` and `progress` name. */
  appBlockId: string;
  /** The counters and marks the collection declares, presented at 0 when untouched. */
  declared: DeclaredTallies;
  /** Content levels on for the app (`isSharedDocLevelsOn`: an unreadable flag counts as on). */
  levelsOn: boolean;
};

export type ResolveLevelStream = (schema: string) => Promise<SharedLevelCollection | null>;

/** The level reads of the document store's registry feed (`createDocStoreFeed`). */
export type LevelDocSource = {
  head(appId: string): Promise<number>;
  markHead(appId: string): Promise<number | null>;
  changes(
    appId: string,
    coll: string,
    selector: LevelSelector,
    after: number,
    upTo: number,
    limit: number,
    declared: DeclaredTallies
  ): Promise<LevelChangesPage>;
  documents(
    appId: string,
    coll: string,
    selector: LevelSelector,
    beforeKey: string,
    upTo: number,
    limit: number,
    declared: DeclaredTallies
  ): Promise<LevelStreamDocument[]>;
  byKeys(
    appId: string,
    coll: string,
    selector: LevelSelector,
    keys: readonly string[],
    declared: DeclaredTallies
  ): Promise<LevelStreamDocument[]>;
  tallyKeys(
    appId: string,
    coll: string,
    after: number,
    upTo: number,
    limit: number
  ): Promise<Array<{ key: string; markSeq: number }> | null>;
  witness(
    appId: string,
    coll: string,
    key: string
  ): Promise<{ docSeq: number | null; tombSeq: number | null }>;
};

/**
 * How full each open level stream is, for the 75% alert: per open subscription, its level, the
 * records it holds and its bound. {@link LevelStreamFill.byLevel} is what the metric reads.
 */
export function createLevelStreamFill() {
  const open = new Map<symbol, { level: string; records: number; bound: number }>();
  return {
    set(id: symbol, level: string, records: number, bound: number) {
      open.set(id, { level, records, bound });
    },
    drop(id: symbol) {
      open.delete(id);
    },
    /** Per level, the fullest open stream: its records and its fraction of its bound. */
    byLevel(): Map<string, { records: number; ratio: number }> {
      const out = new Map<string, { records: number; ratio: number }>();
      for (const s of open.values()) {
        const ratio = s.records / s.bound;
        const at = out.get(s.level);
        if (!at || ratio > at.ratio) out.set(s.level, { records: s.records, ratio });
      }
      return out;
    },
  };
}
export type LevelStreamFill = ReturnType<typeof createLevelStreamFill>;

/**
 * The level streams' fill on `registry`: per level (`1` … `16`, `none`, `counters`), the fullest
 * open stream's fraction of its bound (`registry_adapter_level_stream_fill_ratio`, alert at 0.75)
 * and its records (`registry_adapter_level_stream_records`). A level with no open stream has no
 * series. No label names an app, a collection or a client.
 */
export function createLevelStreamMetrics(registry: Registry, fill: LevelStreamFill) {
  const ratio = new Gauge({
    name: 'registry_adapter_level_stream_fill_ratio',
    help: 'The fullest open shared-collection level stream per level, as a fraction of its record bound.',
    labelNames: ['level'],
    registers: [registry],
    collect() {
      this.reset();
      for (const [level, v] of fill.byLevel()) this.set({ level }, v.ratio);
    },
  });
  const records = new Gauge({
    name: 'registry_adapter_level_stream_records',
    help: 'The records held by the fullest open shared-collection level stream per level.',
    labelNames: ['level'],
    registers: [registry],
    collect() {
      this.reset();
      for (const [level, v] of fill.byLevel()) this.set({ level }, v.records);
    },
  });
  return { ratio, records };
}

export type LevelFeedOptions = {
  /** {@link parseSharedLevelClients}; empty routes nothing here. */
  clients: ReadonlySet<string>;
  source: LevelDocSource;
  resolve: ResolveLevelStream;
  store: SnapshotStore;
  pollMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** {@link parseLevelStreamMaxRecords}; must be above {@link MIN_LEVEL_STREAM_RECORDS}. */
  maxRecords: number;
  fill?: LevelStreamFill;
  onError?: (err: unknown) => void;
};

export const LEVEL_PAGE = 500;
const STATE_FORMAT = 'l1';
const CURSOR_RE = /^l1\.([0-9a-f]{32})$/;
/**
 * The version of what a level entity carries, folded into its rev, so a change to it re-sends
 * every entity rather than expiring a cursor.
 */
export const LEVEL_BODY_FORMAT = 'e1';

type LevelState = {
  v: typeof STATE_FORMAT;
  schema: string;
  /** {@link LevelName}, as a string: `"1"` … `"16"`, `none` or `counters`. */
  level: string;
  /** The content-levels mode the state was served in. */
  levels: 'on' | 'off';
  /** The token subject the state was served to. */
  subject: string;
  appId: string;
  appBlockId: string;
  /** The document head the poll that computed this state read, before its rows. */
  seq: number;
  /** The mark head it read, before its rows; null where the store has no mark sequence. */
  markSeq: number | null;
  family: string;
  /** The bound the window was cut at: a resume under another bound reads in full. */
  bound: number;
  /** Whether documents on the stream lay beyond the window when it was read. */
  truncated: boolean;
  witness: { key: string; seq: number } | null;
  /** [key, rev, seq] of every document served, sorted by key. */
  served: Array<[key: string, rev: string, seq: number]>;
};

const levelString = (level: LevelName) => String(level);
const selectorOf = (level: LevelName): LevelSelector =>
  level === 'none' || level === 'counters' ? level : { bit: level };
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A level entity's rev: everything the entity carries, under {@link LEVEL_BODY_FORMAT}. */
export const levelRev = (d: LevelStreamDocument, schemas: readonly string[]) =>
  sha256Hex(
    sortedKeyJson({
      f: LEVEL_BODY_FORMAT,
      key: d.key,
      seq: d.seq,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      tallies: d.tallies,
      rev: docRev(d, schemas),
    })
  ).slice(0, 16);

/** What a level stream's `live` and `progress` carry: its heads, its mode and its block. */
const levelMeta = (state: Pick<LevelState, 'seq' | 'markSeq' | 'levels' | 'appBlockId'>) => ({
  ...headMeta(state.seq, state.markSeq),
  levels: state.levels,
  block: state.appBlockId,
});

const end = (reason: 'levels_on' | 'levels_off' | 'not_resolved', levels?: 'on' | 'off') =>
  new StreamEnd({ reason, ...(levels ? { levels } : {}) });

export function createLevelFeed(opts: LevelFeedOptions) {
  if (!(opts.maxRecords > MIN_LEVEL_STREAM_RECORDS)) {
    throw new Error(`level-feed: maxRecords must be above ${MIN_LEVEL_STREAM_RECORDS}`);
  }
  const claimer = createClaimer();
  const bound = opts.maxRecords;
  const streamKey = (s: Pick<LevelState, 'schema' | 'level' | 'subject'>) =>
    `${s.schema}#lvl:${s.level}#${s.subject}`;

  const save = async (state: LevelState): Promise<string> => {
    const raw = sortedKeyJson(state);
    const digest = sha256Hex(raw).slice(0, 32);
    await opts.store.put(digest, raw, streamKey(state));
    return `${STATE_FORMAT}.${digest}`;
  };

  /** The level a subscription names, after the token gate; throws for one not routed here. */
  const requested = (schema: string, ctx: AdapterContext): LevelName => {
    const level = parseLevel(ctx.meta);
    if (!isLevelSubscription(opts.clients, schema, ctx) || level === null) {
      throw cursorExpired('this subscription is not a level stream');
    }
    return level;
  };

  /** The state a cursor names, every binding checked before any of it is used. */
  const load = async (schema: string, cursor: string, ctx: AdapterContext): Promise<LevelState> => {
    const digest = CURSOR_RE.exec(cursor)?.[1];
    if (!digest) throw cursorExpired('not a cursor this source issued');
    // Before the store is read: only a level subscription resumes a level stream.
    const level = requested(schema, ctx);
    const raw = await opts.store.get(digest);
    if (raw === null) throw cursorExpired('the state this cursor names is no longer held');
    let state: LevelState;
    try {
      state = JSON.parse(raw) as LevelState;
    } catch {
      throw cursorExpired('the state this cursor names is unreadable');
    }
    if (state.v !== STATE_FORMAT || state.schema !== schema) {
      throw cursorExpired('the cursor belongs to another stream');
    }
    if (state.level !== levelString(level)) {
      throw cursorExpired('the cursor was issued for another level');
    }
    if (state.subject !== ctx.reader?.subject) {
      throw cursorExpired('the cursor was issued to another token subject');
    }
    await opts.store.touch(digest, streamKey(state));
    return state;
  };

  /** The newest event of each key in the seq range (`after`, `upTo`], as `doc-feed.ts` reads it. */
  async function readChanged(
    s: SharedLevelCollection,
    selector: LevelSelector,
    after: number,
    upTo: number
  ): Promise<Map<string, LevelStreamDocument | null>> {
    const latest = new Map<string, { seq: number; doc: LevelStreamDocument | null }>();
    const note = (key: string, seq: number, doc: LevelStreamDocument | null) => {
      const at = latest.get(key);
      if (!at || at.seq < seq) latest.set(key, { seq, doc });
    };
    let from = after;
    while (from < upTo) {
      const page = await opts.source.changes(
        s.appId,
        s.collection,
        selector,
        from,
        upTo,
        LEVEL_PAGE,
        s.declared
      );
      // A full page may stop short of a later event of the other kind, so only the range both
      // pages cover is settled.
      let frontier = upTo;
      if (page.docs.length === LEVEL_PAGE)
        frontier = Math.min(frontier, page.docs[page.docs.length - 1].seq);
      if (page.tombs.length === LEVEL_PAGE)
        frontier = Math.min(frontier, page.tombs[page.tombs.length - 1].seq);
      for (const d of page.docs) {
        if (d.seq > frontier) continue;
        const { onStream, ...doc } = d;
        note(d.key, d.seq, onStream ? doc : null);
      }
      for (const t of page.tombs) if (t.seq <= frontier) note(t.key, t.seq, null);
      from = frontier;
    }
    return new Map([...latest].map(([key, { doc }]) => [key, doc]));
  }

  /** The keys whose tallies changed in the mark range (`after`, `upTo`]; null with no sequence. */
  async function readTallyKeys(
    s: SharedLevelCollection,
    after: number,
    upTo: number
  ): Promise<Set<string> | null> {
    const keys = new Set<string>();
    let from = after;
    while (from < upTo) {
      const page = await opts.source.tallyKeys(s.appId, s.collection, from, upTo, LEVEL_PAGE);
      if (page === null) return null;
      for (const r of page) keys.add(r.key);
      // Each mark sequence stamps one tally row (`SQL_STAMP_TALLY`), so the last row's is a
      // settled frontier.
      if (page.length < LEVEL_PAGE) break;
      from = page[page.length - 1].markSeq;
    }
    return keys;
  }

  /**
   * The stream's state now, from `prev` (null for a snapshot), and the entities to upsert. Throws
   * {@link StreamEnd} when the stream cannot be served (see the file comment's MODE).
   */
  async function advance(
    schema: string,
    level: LevelName,
    prev: LevelState | null,
    ctx: AdapterContext,
    audience: Audience
  ): Promise<{ next: LevelState; entities: Map<string, Entity> }> {
    const s = await opts.resolve(schema);
    if (!s || !audienceAdmits(audience, s.contentRating)) throw end('not_resolved');
    const mode = s.levelsOn ? 'on' : 'off';
    if (level === 'none' && s.levelsOn) throw end('levels_on', 'on');
    if (level !== 'none' && level !== 'counters' && !s.levelsOn) throw end('levels_off', 'off');
    if (prev && prev.appId !== s.appId) {
      throw cursorExpired('the collection now belongs to a different app');
    }
    const selector = selectorOf(level);

    // The heads, BEFORE any row (see the file comment's POLL).
    const seq = await opts.source.head(s.appId);
    const markSeq = await opts.source.markHead(s.appId);
    if (prev && seq < prev.seq) throw cursorExpired('the namespace seq went back');
    if (prev && prev.markSeq !== null && markSeq !== null && markSeq < prev.markSeq) {
      throw cursorExpired('the namespace mark sequence went back');
    }
    if (prev?.witness) {
      const w = await opts.source.witness(s.appId, s.collection, prev.witness.key);
      const since = prev.witness.seq;
      if (!((w.docSeq ?? -1) >= since || (w.tombSeq ?? -1) >= since)) {
        throw cursorExpired('a document this cursor served is gone without a trace');
      }
    }

    const digest = familyDigest(s.family);
    // A full read: a new stream, other schemas, another bound, or a mark sequence that appeared
    // or vanished (what changed meanwhile cannot be read by range).
    const full =
      !prev ||
      prev.family !== digest ||
      prev.bound !== bound ||
      (prev.markSeq === null) !== (markSeq === null);
    const base = {
      v: STATE_FORMAT,
      schema,
      level: levelString(level),
      levels: mode,
      subject: ctx.reader?.subject ?? '',
      appId: s.appId,
      appBlockId: s.appBlockId,
      seq,
      markSeq,
      family: digest,
      bound,
    } as const;
    if (
      prev &&
      !full &&
      seq === prev.seq &&
      markSeq === prev.markSeq &&
      prev.levels === mode &&
      prev.appBlockId === s.appBlockId
    ) {
      return { next: prev, entities: new Map() };
    }

    const claims = claimer(s.family, digest);
    const served = new Map<string, { rev: string; seq: number }>();
    const entities = new Map<string, Entity>();
    const keep = (d: LevelStreamDocument) => {
      const schemas = claims(d.data);
      if (!schemas.includes(schema)) return;
      const urn = registryUrn({
        kind: 'document',
        slug: s.slug,
        collection: s.collection,
        key: d.key,
      });
      const rev = levelRev(d, schemas);
      served.set(d.key, { rev, seq: d.seq });
      entities.set(d.key, {
        urn,
        schemas,
        rev,
        body: d.data,
        key: d.key,
        seq: d.seq,
        version: d.version,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        tallies: d.tallies,
      });
    };
    /** Reads the stream's documents below `before`, newest first, until `want` are served. */
    const readDown = async (before: string, want: number): Promise<boolean> => {
      let cursor = before;
      const target = served.size + want;
      for (;;) {
        const page = await opts.source.documents(
          s.appId,
          s.collection,
          selector,
          cursor,
          seq,
          LEVEL_PAGE,
          s.declared
        );
        for (const d of page) {
          keep(d);
          if (served.size >= target) return true;
        }
        if (page.length < LEVEL_PAGE) return false;
        cursor = page[page.length - 1].key;
      }
    };

    let truncated: boolean;
    if (full) {
      // One past the bound, so a board exactly at it is not called truncated.
      truncated = await readDown('', bound + 1);
    } else {
      for (const [key, rev, at] of prev.served) served.set(key, { rev, seq: at });
      const changed = await readChanged(s, selector, prev.seq, seq);
      if (markSeq !== null && prev.markSeq !== null && markSeq > prev.markSeq) {
        const tallied = await readTallyKeys(s, prev.markSeq, markSeq);
        const reread = [...(tallied ?? [])].filter((k) => !changed.has(k));
        for (let i = 0; i < reread.length; i += LEVEL_PAGE) {
          const chunk = reread.slice(i, i + LEVEL_PAGE);
          const found = new Map(
            (await opts.source.byKeys(s.appId, s.collection, selector, chunk, s.declared)).map(
              (d) => [d.key, d]
            )
          );
          for (const k of chunk) changed.set(k, found.get(k) ?? null);
        }
      }
      // A truncated window holds the newest `bound` documents, so its lowest key is a floor: a
      // document that changed below it is beyond the window, and comes in only by the backfill,
      // in key order, never ahead of the unserved documents between it and the floor.
      const floor = prev.truncated && prev.served.length > 0 ? prev.served[0][0] : null;
      for (const [key, doc] of changed) {
        served.delete(key);
        if (doc && (floor === null || key >= floor)) keep(doc);
      }
      truncated = prev.truncated;
      if (served.size < bound && truncated) {
        // A delete or re-rating inside the window: backfill the next-newest from beyond it.
        const below = [...served.keys()].sort(byKey)[0] ?? '';
        truncated = await readDown(below, bound - served.size + 1);
      }
    }
    // Past the bound: keep the newest by key.
    const keys = [...served.keys()].sort(byKey);
    if (keys.length > bound) {
      truncated = true;
      for (const k of keys.slice(0, keys.length - bound)) {
        served.delete(k);
        entities.delete(k);
      }
    }

    let witness: LevelState['witness'] = null;
    for (const [key, v] of served)
      if (!witness || v.seq > witness.seq) witness = { key, seq: v.seq };
    return {
      next: {
        ...base,
        truncated,
        witness,
        served: [...served]
          .map(([key, v]) => [key, v.rev, v.seq] as [string, string, number])
          .sort((a, b) => byKey(a[0], b[0])),
      },
      entities,
    };
  }

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProtocolError || err instanceof StreamEnd) throw err;
      opts.onError?.(err);
      throw new ProtocolError('unavailable', 'the level stream could not be read');
    }
  };

  async function* follow(
    schema: string,
    level: LevelName,
    cursor: string,
    loaded: LevelState,
    first: Awaited<ReturnType<typeof advance>>,
    ctx: AdapterContext,
    audience: Audience
  ): AsyncGenerator<Change> {
    const id = Symbol('level-stream');
    const ref = parseCollectionSchemaUrn(schema);
    const urnOf = (key: string) =>
      registryUrn({
        kind: 'document',
        slug: ref?.slug ?? '',
        collection: ref?.collection ?? '',
        key,
      });
    let state = loaded;
    let position = cursor;
    let pending: Awaited<ReturnType<typeof advance>> | StreamEnd | null = first;
    // What `live` carried (the loaded state's), then the last `progress`.
    let sent = sortedKeyJson(levelMeta(loaded));
    try {
      while (!ctx.signal.aborted) {
        const before = state;
        let step: Awaited<ReturnType<typeof advance>> | StreamEnd;
        if (pending !== null) step = pending;
        else {
          try {
            step = await guarded(() => advance(schema, level, before, ctx, audience));
          } catch (err) {
            if (!(err instanceof StreamEnd)) throw err;
            step = err;
          }
        }
        pending = null;
        if (step instanceof StreamEnd) {
          if (!ctx.signal.aborted) yield { end: step.meta };
          return;
        }
        const { next, entities } = step;
        opts.fill?.set(id, next.level, next.served.length, next.bound);
        if (next !== before) {
          const was = new Map(before.served.map(([key, rev]) => [key, rev]));
          const still = new Set(next.served.map(([key]) => key));
          const deletes = [...was.keys()].filter((k) => !still.has(k)).sort(byKey);
          const upserts = next.served
            .filter(([key, rev]) => was.get(key) !== rev)
            .map(([key]) => entities.get(key))
            .filter((e): e is Entity => e !== undefined);
          const diff: Array<{ delete: string } | { upsert: Entity }> = [
            ...deletes.map((key) => ({ delete: urnOf(key) })),
            ...upserts.map((upsert) => ({ upsert })),
          ];
          state = next;
          if (diff.length > 0) {
            const nextCursor = await guarded(() => save(next));
            for (let i = 0; i < diff.length; i++) {
              if (ctx.signal.aborted) return;
              const at = i === diff.length - 1 ? nextCursor : position;
              const c = diff[i];
              yield 'upsert' in c
                ? { upsert: c.upsert, cursor: at }
                : { delete: c.delete, cursor: at };
            }
            position = nextCursor;
          } else if (next.levels !== before.levels || next.appBlockId !== before.appBlockId) {
            // The mode or the block moved with nothing to send: saved, so the progress cursor is
            // one a resume is bound to.
            position = await guarded(() => save(next));
          }
        }
        // After the poll's changes, so a consumer holds all of them when it reads the heads.
        const meta = levelMeta(state);
        const key = sortedKeyJson(meta);
        if (key !== sent) {
          if (ctx.signal.aborted) return;
          sent = key;
          yield { progress: position, meta };
        }
        await opts.sleep(opts.pollMs, ctx.signal);
      }
    } finally {
      opts.fill?.drop(id);
    }
  }

  return {
    /** Whether a subscription is routed here (see the file comment's ROUTING). */
    routes(schema: string, ctx: Pick<AdapterContext, 'reader' | 'meta'>): boolean {
      return isLevelSubscription(opts.clients, schema, ctx);
    },

    /** Whether a cursor is one this feed issued. */
    issued(cursor: string): boolean {
      return CURSOR_RE.test(cursor);
    },

    async snapshot(schema: string, ctx: AdapterContext) {
      const level = requested(schema, ctx);
      const audience = contextAudience(ctx);
      const { next, entities } = await guarded(() => advance(schema, level, null, ctx, audience));
      const cursor = await guarded(() => save(next));
      // Newest first, as the window is cut.
      const ordered = next.served
        .map(([key]) => entities.get(key))
        .filter((e): e is Entity => e !== undefined)
        .reverse();
      return { cursor, entities: ordered };
    },

    async changes(schema: string, cursor: string, ctx: AdapterContext) {
      const level = requested(schema, ctx);
      const audience = contextAudience(ctx);
      const state = await guarded(() => load(schema, cursor, ctx));
      const current = await guarded(() => opts.resolve(schema));
      // The mode is part of the binding: a counters cursor from the other mode starts over. A
      // bit or `none` stream in a mode it cannot be served in is ended by `advance` below.
      if (level === 'counters' && current && (current.levelsOn ? 'on' : 'off') !== state.levels) {
        throw cursorExpired('the cursor was issued under the other content-levels mode');
      }
      // Rejects before `live` (a StreamEnd included): every history check is a cursor check.
      const first = await guarded(() => advance(schema, level, state, ctx, audience));
      return Object.assign(follow(schema, level, cursor, state, first, ctx, audience), {
        liveMeta: levelMeta(state) as EventMeta,
      });
    },
  };
}
