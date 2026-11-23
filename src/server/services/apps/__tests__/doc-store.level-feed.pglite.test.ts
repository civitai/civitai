import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { createMemorySnapshotStore } from '../../../../../scripts/registry-adapter-fixture/fixture-source';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { ctx, freshApp, NS_PROD, POSTS, TALLIES, VIEWER_1, VIEWER_2 } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry LEVEL STREAMS (`registry-adapter/level-feed.ts`) over the REAL store reads
 * (`createDocStoreFeed`'s level reads, `docStoreLevelSource`) on the embedded Postgres, with the
 * content-level columns and the mark sequence migrated, as `appdata_rw` with row-level security
 * ON. Ratings are applied by the real rater (`applyRating`, which takes the next seq), hides by the
 * real moderation, votes and reports by the real `mark`. Levels are NsfwLevel bits; each document
 * sits at a distinct bit and carries a distinct body, and the vote and star counts differ.
 */

const MOD = 9_377;
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
  const docSeq = async (key: string) => (await feed.feedWitness(app, POSTS.name, key)).docSeq;

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
    await store.mark(me, POSTS, 'p04-r', 'vote');
    await store.mark(them, POSTS, 'p04-r', 'vote');
    await store.mark(me, POSTS, 'p04-r', 'star');
    await store.mark(them, POSTS, 'p04-r', 'report');
    await store.increment(me, TALLIES, 'c-plays', 'plays', 3);

    const collections = new Map<string, SharedLevelCollection>(
      [POSTS, TALLIES].map((coll) => [
        schemaOf(coll),
        {
          appId: app,
          slug: SLUG,
          collection: coll.name,
          contentRating: 'pg13',
          family: [{ urn: schemaOf(coll), body: { type: 'object' } }],
          appBlockId: app,
          declared: { counters: coll.config.counters ?? [], marks: coll.config.marks ?? [] },
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

  it('🔴 an entity carries its tallies with the report count left out, and never an author or marks', async () => {
    const run = await open(4);
    const [e] = upserted(run.events);
    expect(e).toMatchObject({
      key: 'p04-r',
      body: { t: 'body-p04-r' },
      version: 1,
      seq: await docSeq('p04-r'),
      tallies: { counters: { vote: 0, views: 0 }, marks: { vote: 2, star: 1 } },
    });
    expect(Object.keys(e).sort()).toEqual(
      [
        'body',
        'createdAt',
        'key',
        'rev',
        'schemas',
        'seq',
        'tallies',
        'updatedAt',
        'urn',
        'version',
      ].sort()
    );
    expect(JSON.stringify(e)).not.toMatch(/report|author|viewer/);
    // The heads it names are the store's.
    expect(metaOf(run.events, 'live')).toEqual([
      {
        head: { seq: await feed.feedHead(app), markSeq: await feed.feedMarkHead(app) },
        levels: 'on',
        block: app,
      },
    ]);
    await close(run);
  });

  it('🔴 a vote moves the mark head and the tally on its document’s stream, leaving its seq; a report moves only the head', async () => {
    const r = await open(4);
    const x = await open(8);
    const seqBefore = await docSeq('p04-r');
    const markBefore = (await feed.feedMarkHead(app)) ?? 0;
    await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'p04-r', 'star');
    const [fromR, fromX] = await pollAll(r, x);
    expect(upserted(fromR).map((e) => [e.key, e.seq, e.tallies?.marks])).toEqual([
      ['p04-r', seqBefore, { vote: 2, star: 2 }],
    ]);
    expect(await docSeq('p04-r')).toBe(seqBefore);
    const head = await feed.feedHead(app);
    for (const batch of [fromR, fromX]) {
      expect(metaOf(batch, 'progress')).toEqual([
        { head: { seq: head, markSeq: markBefore + 1 }, levels: 'on', block: app },
      ]);
    }
    expect(upserted(fromX)).toEqual([]);

    await store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'p04-r', 'report');
    const [reported] = await pollAll(r, x);
    expect(upserted(reported)).toEqual([]);
    expect(metaOf(reported, 'progress')).toEqual([
      { head: { seq: head, markSeq: markBefore + 2 }, levels: 'on', block: app },
    ]);
    await close(r, x);
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

  it('the counters stream holds counter documents with their counters; no bit stream does', async () => {
    const counters = await open('counters', TALLIES);
    expect(upserted(counters.events).map((e) => [e.key, e.tallies])).toEqual([
      ['c-plays', { counters: { plays: 3 }, marks: {} }],
    ]);
    const pg = await open(1, TALLIES);
    expect(upserted(pg.events)).toEqual([]);
    await close(counters, pg);
  });
});
