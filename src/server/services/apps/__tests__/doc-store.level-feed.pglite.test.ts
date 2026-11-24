import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '~/server/registry-adapter/auth';
import { SERVICE_AUDIENCE } from '~/server/registry-adapter/audience';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { docStoreLevelSource } from '~/server/registry-adapter/doc-source';
import { composeAdapter } from '~/server/registry-adapter/doc-streams';
import type { SharedLevelCollection } from '~/server/registry-adapter/level-feed';
import { createLevelFeed, parseSharedLevelClients } from '~/server/registry-adapter/level-feed';
import type { Adapter, Entity, StreamEvent } from '~/server/registry-adapter/protocol';
import { createSubscriber } from '~/server/registry-adapter/subscription';
import type {
  DocStore,
  DocStoreFeed,
  DocStoreModeration,
  DocStoreRater,
} from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreModeration,
  createDocStoreRater,
} from '~/server/services/apps/doc-store';
import { deriveViewerKey } from '~/server/services/apps/doc-store-viewer-keyed';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { createMemorySnapshotStore } from '../../../../../scripts/registry-adapter-fixture/fixture-source';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  ctx,
  decl,
  freshApp,
  NS_PROD,
  POSTS,
  TALLIES,
  VIEWER_1,
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry LEVEL STREAMS (`registry-adapter/level-feed.ts`) over the REAL store reads
 * (`createDocStoreFeed`'s level reads, `docStoreLevelSource`) on the embedded Postgres, with the
 * content-level columns migrated, as `appdata_rw` with row-level security ON. Ratings are applied
 * by the real rater (`applyRating`, which takes the next seq), hides by the real moderation. Each
 * entity is a PLAIN document (`docs/app-storage-generic-core.md`, "Registry and app-data-go
 * impact"): no tallies, no author, one sequence. Levels are NsfwLevel bits; each document sits at
 * a distinct bit and carries a distinct body.
 */

const MOD = 9_377;
const SECRET = 'level-feed-pglite-derivation-secret';
/** A viewer-keyed votes collection (`keyedBy`, merged in the generic core). */
const VOTES: DocCollection = {
  name: 'votes',
  config: decl({ visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' }),
};
const LEVEL_CLIENT = 'svc-appdata-pg-61b4';
const SLUG = 'pg-bench-board';
const schemaOf = (coll: DocCollection) => `urn:schema:apps.civitai.com:${SLUG}/${coll.name}@v1`;
const urnOf = (coll: DocCollection, key: string) =>
  `urn:apps.civitai.com:${SLUG}/${coll.name}/${key}`;

const principal: Principal = {
  subject: `service:${LEVEL_CLIENT}`,
  service: true,
  clientId: LEVEL_CLIENT,
  actor: null,
  token: { userId: null, clientId: LEVEL_CLIENT, scope: BigInt(0), actor: null },
  audience: SERVICE_AUDIENCE,
  expiresAt: null,
  recheck: null,
};

const wakers: Array<() => void> = [];
const sleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    // A stream stopped mid-poll sleeps once more after its abort: that sleep must end at once.
    if (signal.aborted) return resolve();
    wakers.push(resolve);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
const wake = () => wakers.splice(0).forEach((w) => w());

describe('the level streams over the store (rls on)', () => {
  let h: Harness;
  let store: DocStore;
  let feed: DocStoreFeed;
  let mod: DocStoreModeration;
  let rater: DocStoreRater;
  let app: string;
  let adapter: Adapter;

  const rate = async (coll: DocCollection, key: string, level: number) => {
    const seq = (await feed.feedWitness(app, coll.name, key)).docSeq;
    const out = await rater.applyRating(app, NS_PROD, coll.name, key, { seq: seq ?? 0, level });
    expect(out.applied).toBe(true);
  };
  const docSeq = async (key: string, coll: DocCollection = POSTS) =>
    (await feed.feedWitness(app, coll.name, key)).docSeq;
  const voteKey = (parent: string, viewerUid: number) =>
    deriveViewerKey(SECRET, {
      appId: app,
      ns: NS_PROD,
      collection: VOTES.name,
      mode: 'parent+viewer',
      parent,
      viewerUid,
    });
  /** Exactly what a level entity carries: a plain document, and the envelope. */
  const PLAIN_ENTITY_KEYS = [
    'body',
    'createdAt',
    'key',
    'rev',
    'schemas',
    'seq',
    'updatedAt',
    'urn',
    'version',
  ].sort();

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true, docLevels: true });
    store = createDocStore({ db: h.db });
    feed = createDocStoreFeed({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
    rater = createDocStoreRater({ db: h.db });
    app = freshApp('levelfeed');
    const me = ctx(app, NS_PROD, VIEWER_1);
    const them = ctx(app, NS_PROD, VIEWER_2);
    const at: Array<[string, number | null]> = [
      ['p01-pg', 1],
      ['p02-pg13', 2],
      ['p04-r', 4],
      ['p08-x', 8],
      ['p16-xxx', 16],
      ['p32-blocked', 32],
      ['pu-unrated', null],
      ['ph-hidden', 4],
    ];
    for (const [key, level] of at) {
      await store.put(me, POSTS, key, { t: `body-${key}` });
      if (level !== null) await rate(POSTS, key, level);
    }
    await mod.setHidden(app, NS_PROD, POSTS.name, 'ph-hidden', true, MOD);
    // Tallies the store still holds: a level entity carries none of them.
    await store.mark(me, POSTS, 'p04-r', 'vote');
    await store.mark(them, POSTS, 'p04-r', 'star');
    await store.mark(them, POSTS, 'p04-r', 'report');
    await store.increment(me, TALLIES, 'c-plays', 'plays', 3);
    // Two viewers' votes on one parent, each at the key the `@me` route derives for it.
    for (const [viewer, value] of [
      [VIEWER_1, 1],
      [VIEWER_2, -1],
    ] as const) {
      const key = voteKey('p04-r', viewer);
      await store.put(ctx(app, NS_PROD, viewer), VOTES, key, { value });
      await rate(VOTES, key, 1);
    }

    const collections = new Map<string, SharedLevelCollection>(
      [POSTS, TALLIES, VOTES].map((coll) => [
        schemaOf(coll),
        {
          appId: app,
          slug: SLUG,
          collection: coll.name,
          contentRating: 'pg13',
          family: [{ urn: schemaOf(coll), body: { type: 'object' } }],
          appBlockId: app,
          levelsOn: true,
        },
      ])
    );
    const snapshots = createMemorySnapshotStore();
    adapter = composeAdapter(
      {
        namespace: 'apps.civitai.com',
        serves: () => false,
        snapshot: async () => ({ cursor: '', entities: [] }),
        changes: async () => {
          throw new Error('the entity streams are not under test');
        },
      },
      createDocFeed({
        source: {
          head: async () => 0,
          changes: async () => ({ docs: [], tombs: [] }),
          documents: async () => [],
          witness: async () => ({ docSeq: null, tombSeq: null }),
        },
        resolve: async () => null,
        store: snapshots,
        pollMs: 60_000,
        sleep,
      }),
      undefined,
      createLevelFeed({
        clients: parseSharedLevelClients(LEVEL_CLIENT),
        source: docStoreLevelSource(feed),
        resolve: async (schema) => collections.get(schema) ?? null,
        store: snapshots,
        pollMs: 60_000,
        sleep,
        maxRecords: 2_001,
      })
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  type Run = { events: StreamEvent[]; done: Promise<unknown>; stop: () => void };
  /** Every stream a case opened: stopped after it, so a failed assertion never leaves one open. */
  const opened: Run[] = [];
  afterEach(async () => {
    const runs = opened.splice(0);
    for (const r of runs) r.stop();
    wake();
    await Promise.all(runs.map((r) => r.done));
  });
  const settle = async (run: Run, parked: number) => {
    let finished = false;
    void run.done.then(() => (finished = true));
    for (let i = 0; i < 20_000 && wakers.length < parked && !finished; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  const open = async (level: unknown, coll: DocCollection = POSTS): Promise<Run> => {
    const parked = wakers.length;
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    const done = createSubscriber(adapter)(
      { schema: schemaOf(coll), urns: [], meta: { level } },
      { signal: abort.signal, send: async (e) => void events.push(e) },
      principal
    ).catch((err: unknown) => err);
    const run = { events, done, stop: () => abort.abort() };
    opened.push(run);
    await settle(run, parked + 1);
    return run;
  };
  /** One poll of every open stream; each run's events since. */
  const pollAll = async (...runs: Run[]) => {
    const marks = runs.map((r) => r.events.length);
    wake();
    await settle(runs[0], runs.length);
    return runs.map((r, i) => r.events.slice(marks[i]));
  };
  const close = async (...runs: Run[]) => {
    for (const r of runs) r.stop();
    wake();
    await Promise.all(runs.map((r) => r.done));
  };
  const upserted = (events: StreamEvent[]): Entity[] =>
    events.flatMap((e) => (e.type === 'upsert' ? [e.entity] : []));
  const deleted = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === 'delete' ? [e.urn] : []));
  const metaOf = (events: StreamEvent[], type: 'live' | 'progress') =>
    events.flatMap((e) => (e.type === type ? [e.meta] : []));

  it('🔴 the five bit streams partition the rated board; the unrated, Blocked, hidden and counter documents are on none', async () => {
    const held: Record<number, string[]> = {};
    for (const bit of [1, 2, 4, 8, 16]) {
      const run = await open(bit);
      held[bit] = upserted(run.events).map((e) => e.key ?? '');
      await close(run);
    }
    expect(held).toEqual({
      1: ['p01-pg'],
      2: ['p02-pg13'],
      4: ['p04-r'],
      8: ['p08-x'],
      16: ['p16-xxx'],
    });
    // Positive control: the unrated, Blocked and hidden rows exist.
    for (const key of ['pu-unrated', 'p32-blocked', 'ph-hidden']) {
      expect(typeof (await docSeq(key))).toBe('number');
    }
  });

  it('🔴 an entity is a plain document: key, body, version, timestamps and seq; no tallies, author or marks', async () => {
    const run = await open(4);
    const [e] = upserted(run.events);
    expect(e).toMatchObject({
      key: 'p04-r',
      body: { t: 'body-p04-r' },
      version: 1,
      seq: await docSeq('p04-r'),
    });
    // The document holds a vote, a star and a report: none of them is on the entity.
    expect(Object.keys(e).sort()).toEqual(PLAIN_ENTITY_KEYS);
    expect(JSON.stringify(e)).not.toMatch(/tallies|marks|counters|report|author|viewer/);
    // One sequence: the head it names is the store's seq head, and nothing else.
    expect(metaOf(run.events, 'live')).toEqual([
      { head: { seq: await feed.feedHead(app) }, levels: 'on', block: app },
    ]);
    await close(run);
  });

  it('🔴 a mark moves nothing on a level stream; a write is an Upsert at its new seq, and the head follows it', async () => {
    const run = await open(4);
    const seqBefore = await docSeq('p04-r');
    const headBefore = await feed.feedHead(app);
    await store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p04-r', 'star');
    const [afterMark] = await pollAll(run);
    expect(afterMark).toEqual([]);
    expect([await docSeq('p04-r'), await feed.feedHead(app)]).toEqual([seqBefore, headBefore]);

    // Positive control: a document write on the same stream is seen.
    await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p04-r', { t: 'body-p04-r-v2' });
    await rate(POSTS, 'p04-r', 4);
    const [afterWrite] = await pollAll(run);
    const seqAfter = await docSeq('p04-r');
    expect(seqAfter).toBeGreaterThan(headBefore);
    expect(upserted(afterWrite).map((e) => [e.key, e.body, e.seq])).toEqual([
      ['p04-r', { t: 'body-p04-r-v2' }, seqAfter],
    ]);
    expect(metaOf(afterWrite, 'progress')).toEqual([
      { head: { seq: await feed.feedHead(app) }, levels: 'on', block: app },
    ]);
    await close(run);
  });

  it('🔴 viewer-keyed votes stream as plain shared documents at their derived keys, carrying no viewer identity', async () => {
    const run = await open(1, VOTES);
    const got = upserted(run.events);
    const k1 = voteKey('p04-r', VIEWER_1);
    const k2 = voteKey('p04-r', VIEWER_2);
    // Positive control: the two viewers' keys differ, and each is `<parent>:<digest>`.
    expect(k1).not.toBe(k2);
    expect([k1, k2].every((k) => /^p04-r:[a-z2-7]{26}$/.test(k))).toBe(true);
    expect(got.map((e) => [e.key, e.body, e.urn]).sort()).toEqual(
      [
        [k1, { value: 1 }, urnOf(VOTES, k1)],
        [k2, { value: -1 }, urnOf(VOTES, k2)],
      ].sort()
    );
    for (const e of got) expect(Object.keys(e).sort()).toEqual(PLAIN_ENTITY_KEYS);
    expect(JSON.stringify(got)).not.toMatch(/author|viewer|isViewer|username/);

    // A re-vote is a document write on the votes stream, ordered by seq like any other.
    const before = await docSeq(k1, VOTES);
    await store.put(ctx(app, NS_PROD, VIEWER_1), VOTES, k1, { value: -1 });
    await rate(VOTES, k1, 1);
    const [revote] = await pollAll(run);
    const after = await docSeq(k1, VOTES);
    expect(after).toBeGreaterThan(before ?? 0);
    expect(upserted(revote).map((e) => [e.key, e.body, e.seq])).toEqual([
      [k1, { value: -1 }, after],
    ]);
    await close(run);
  });

  it('🔴 a re-rating is a Delete on the old bit’s stream and an Upsert on the new one; a moderator hide is a Delete', async () => {
    const pg = await open(1);
    const pg13 = await open(2);
    await rate(POSTS, 'p01-pg', 2);
    const [fromPg, fromPg13] = await pollAll(pg, pg13);
    expect([deleted(fromPg), upserted(fromPg)]).toEqual([[urnOf(POSTS, 'p01-pg')], []]);
    expect([deleted(fromPg13), upserted(fromPg13).map((e) => e.key)]).toEqual([[], ['p01-pg']]);

    await mod.setHidden(app, NS_PROD, POSTS.name, 'p02-pg13', true, MOD);
    const [, hidden] = await pollAll(pg, pg13);
    expect(deleted(hidden)).toEqual([urnOf(POSTS, 'p02-pg13')]);
    await close(pg, pg13);
  });

  it('🔴 the level reads page: newest key first by `beforeKey` with no duplicate or gap, and a bounded changes page holds exactly `limit` rows in seq order', async () => {
    const PAGES: DocCollection = {
      name: 'pages',
      config: decl({ visibility: 'shared', write: 'own' }),
    };
    const source = docStoreLevelSource(feed);
    const me = ctx(app, NS_PROD, VIEWER_1);
    // Seven documents, written and then rated in orders that are neither key order nor each
    // other, so seq order, heap order and key order all differ.
    const written = ['k4', 'k1', 'k7', 'k3', 'k6', 'k2', 'k5'];
    const rated = ['k2', 'k6', 'k1', 'k5', 'k7', 'k3', 'k4'];
    for (const key of written) await store.put(me, PAGES, key, { t: `page-${key}` });
    for (const key of rated) await rate(PAGES, key, 4);
    const upTo = await feed.feedHead(app);
    const LIMIT = 3;

    const pageDown = async (selector: 'none' | { bit: number }) => {
      const pages: string[][] = [];
      let before = '';
      for (;;) {
        const page = await source.documents(app, PAGES.name, selector, before, upTo, LIMIT);
        pages.push(page.map((d) => d.key));
        if (page.length < LIMIT) return pages;
        before = page[page.length - 1].key;
      }
    };
    const expected = [['k7', 'k6', 'k5'], ['k4', 'k3', 'k2'], ['k1']];
    expect(await pageDown('none')).toEqual(expected);
    expect(await pageDown({ bit: 4 })).toEqual(expected);
    // Positive control: the bit read selects by level, so another bit holds none of them.
    expect(await pageDown({ bit: 2 })).toEqual([[]]);

    // The changed set after the first rating is the other six; a page of three is the next three.
    const after = (await docSeq('k2', PAGES)) ?? 0;
    const seqs = await Promise.all(rated.map((key) => docSeq(key, PAGES)));
    expect(seqs.every((s, i) => i === 0 || (s ?? 0) > (seqs[i - 1] ?? 0))).toBe(true);
    for (const selector of ['none', { bit: 4 }] as const) {
      const page = await source.changes(app, PAGES.name, selector, after, upTo, LIMIT);
      expect(page.docs.map((d) => [d.key, d.seq, d.onStream])).toEqual([
        ['k6', seqs[1], true],
        ['k1', seqs[2], true],
        ['k5', seqs[3], true],
      ]);
      expect(page.tombs).toEqual([]);
    }
  });

  it('a counter document is on no level stream', async () => {
    const pg = await open(1, TALLIES);
    expect(upserted(pg.events)).toEqual([]);
    // Positive control: the counter document exists.
    expect(typeof (await docSeq('c-plays', TALLIES))).toBe('number');
    await close(pg);
  });
});
