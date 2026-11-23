import { beforeEach, describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import type { Principal } from '~/server/registry-adapter/auth';
import { SERVICE_AUDIENCE } from '~/server/registry-adapter/audience';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import {
  composeAdapter,
  resolveSharedLevelFromCatalog,
} from '~/server/registry-adapter/doc-streams';
import type { LevelDocSource } from '~/server/registry-adapter/level-feed';
import {
  createLevelFeed,
  createLevelStreamFill,
  createLevelStreamMetrics,
  parseLevelStreamMaxRecords,
  parseSharedLevelClients,
} from '~/server/registry-adapter/level-feed';
import type { Adapter, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { sseFrame } from '~/server/registry-adapter/serve';
import { createSubscriber } from '~/server/registry-adapter/subscription';
import type { LevelSelector, LevelStreamDocument } from '~/server/services/apps/doc-store';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * The shared-collection LEVEL STREAMS (`level-feed.ts`; `apps/app-data-go/WRITES-DESIGN.md`,
 * "The shape", "Feed routing", "Bindings", "Poll shapes and cost", "Size, count and alert"),
 * through the whole core: the shared `Subscribe` core, the composed adapter (public feed + level
 * feed) and the real catalog resolver, over an in-memory document store whose selectors mirror
 * the SQL's (the SQL itself is pinned on PGlite, `doc-store.level-feed.pglite.test.ts`).
 *
 * Every key, level, seq, client, slug and block id is pairwise distinct, and none equals a
 * constant the code names: levels are spread over all five bits, seqs never coincide with a
 * level bit or a bound.
 */

const LEVEL_CLIENT = 'svc-appdata-4e19';
const OTHER_SERVICE = 'svc-index-82c7';
const RELAY_CLIENT = 'relay-exp-3a6d';
const APP_ID = 'ab_board_7f21';
const SLUG = 'bench-board-55';
const SCHEMA = `urn:schema:apps.civitai.com:${SLUG}/records@v1`;
const urnOf = (key: string) => `urn:apps.civitai.com:${SLUG}/records/${key}`;
const BOUND = 2_003;

type Doc = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
  level: number | null;
  hidden: boolean;
  counter: boolean;
  votes: number;
  reports: number;
};
let docs: Map<string, Doc>;
let tombs: Map<string, number>;
/** [key, markSeq] of every tally row stamp, newest last (one per mark sequence). */
let stamps: Array<{ key: string; markSeq: number }>;
let head: number;
let markHead: number | null;
let levelsOn: boolean;
/** Every read the level feed made of the source, in order. */
let reads: string[];
/** Run once, right after the next `changes` read returns: a write that commits mid-poll. */
let afterChangesRead: (() => void) | null;

const onStream = (d: Doc, sel: LevelSelector) =>
  !d.hidden &&
  (sel === 'none'
    ? !d.counter
    : sel === 'counters'
    ? d.counter
    : !d.counter && d.level !== null && (d.level & sel.bit) !== 0);
const present = (d: Doc): LevelStreamDocument => ({
  key: d.key,
  data: d.data,
  version: d.version,
  seq: d.seq,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: `2026-11-02T00:00:${String(d.version).padStart(2, '0')}.000Z`,
  tallies: { counters: {}, marks: { vote: d.votes } },
});

const source: LevelDocSource = {
  head: async () => {
    reads.push('head');
    return head;
  },
  markHead: async () => {
    reads.push('markHead');
    return markHead;
  },
  changes: async (_a, _c, sel, after, upTo, limit) => {
    reads.push('changes');
    const page = {
      docs: [...docs.values()]
        .filter((d) => d.seq > after && d.seq <= upTo)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((d) => ({ ...present(d), onStream: onStream(d, sel) })),
      tombs: [...tombs]
        .filter(([, s]) => s > after && s <= upTo)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([key, seq]) => ({ key, seq })),
    };
    const write = afterChangesRead;
    afterChangesRead = null;
    write?.();
    return page;
  },
  documents: async (_a, _c, sel, beforeKey, upTo, limit) => {
    reads.push('documents');
    return [...docs.values()]
      .filter((d) => onStream(d, sel) && d.seq <= upTo && (beforeKey === '' || d.key < beforeKey))
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .slice(0, limit)
      .map(present);
  },
  byKeys: async (_a, _c, sel, keys) => {
    reads.push('byKeys');
    return keys.flatMap((k) => {
      const d = docs.get(k);
      return d && onStream(d, sel) ? [present(d)] : [];
    });
  },
  tallyKeys: async (_a, _c, after, upTo, limit) => {
    reads.push('tallyKeys');
    if (markHead === null) return null;
    return stamps.filter((s) => s.markSeq > after && s.markSeq <= upTo).slice(0, limit);
  },
  witness: async (_a, _c, key) => ({
    docSeq: docs.get(key)?.seq ?? null,
    tombSeq: tombs.get(key) ?? null,
  }),
};

// The store's writes, each taking the next seq (a document write) or mark sequence (a vote).
const put = (key: string, data: Record<string, unknown>, level: number | null, counter = false) => {
  head += 1;
  const was = docs.get(key);
  docs.set(key, {
    key,
    data,
    version: (was?.version ?? 0) + 1,
    seq: head,
    level,
    hidden: false,
    counter,
    votes: was?.votes ?? 0,
    reports: 0,
  });
};
const rerate = (key: string, level: number) => {
  head += 1;
  const d = docs.get(key);
  if (d) docs.set(key, { ...d, level, seq: head });
};
const hide = (key: string) => {
  head += 1;
  const d = docs.get(key);
  if (d) docs.set(key, { ...d, hidden: true });
  tombs.set(key, head);
};
const remove = (key: string) => {
  head += 1;
  docs.delete(key);
  tombs.set(key, head);
};
const vote = (key: string) => {
  markHead = (markHead ?? 0) + 1;
  const d = docs.get(key);
  if (d) docs.set(key, { ...d, votes: d.votes + 1 });
  stamps.push({ key, markSeq: markHead });
};

const manifest = {
  blockId: SLUG,
  storage: {
    collections: {
      records: {
        visibility: 'shared',
        write: 'own',
        marks: ['vote'],
        schema: { type: 'object', properties: { t: { type: 'string' } } },
      },
      kv: { visibility: 'private' },
    },
  },
};
const catalog = (): CatalogApp[] => [
  {
    listing: {
      slug: SLUG,
      kind: 'onsite',
      name: 'Bench Board',
      tagline: null,
      category: null,
      contentRating: 'pg13',
      iconUrl: null,
      creatorUsername: null,
      externalUrl: null,
      sourceRepoUrl: null,
      forkOf: null,
    },
    block: {
      id: APP_ID,
      blockId: SLUG,
      version: '1.0.0',
      status: 'approved',
      contentRating: 'pg13',
      manifest,
    },
    approved: [],
  },
];

let wakers: Array<() => void>;
const sleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    wakers.push(resolve);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
const wake = () => wakers.splice(0).forEach((w) => w());

let store: ReturnType<typeof createMemorySnapshotStore>;
let fill: ReturnType<typeof createLevelStreamFill>;

const levelFeed = () =>
  createLevelFeed({
    clients: parseSharedLevelClients(` ${LEVEL_CLIENT} ,`),
    source,
    resolve: resolveSharedLevelFromCatalog(
      async () => catalog(),
      async () => levelsOn
    ),
    store,
    pollMs: 60_000,
    sleep,
    maxRecords: BOUND,
    fill,
  });

/** The public feed, as today: it serves this collection nothing (not exported). */
const publicFeed = () =>
  createDocFeed({
    source: {
      head: async () => 0,
      changes: async () => ({ docs: [], tombs: [] }),
      documents: async () => [],
      witness: async () => ({ docSeq: null, tombSeq: null }),
    },
    resolve: async () => null,
    store,
    pollMs: 60_000,
    sleep,
  });

const entityStreams: Adapter = {
  namespace: 'apps.civitai.com',
  serves: () => false,
  snapshot: async () => ({ cursor: '', entities: [] }),
  changes: async () => {
    throw new Error('the entity streams are not under test');
  },
};

const servicePrincipal = (clientId: string): Principal => ({
  subject: `service:${clientId}`,
  service: true,
  clientId,
  actor: null,
  token: { userId: null, clientId, scope: BigInt(0), actor: null },
  audience: SERVICE_AUDIENCE,
  expiresAt: null,
  recheck: null,
});
/** A relay's user token, presented as the level client would be. */
const relayUserPrincipal: Principal = {
  subject: `user:6612/client:${LEVEL_CLIENT}`,
  clientId: LEVEL_CLIENT,
  actor: RELAY_CLIENT,
  token: { userId: 6612, clientId: LEVEL_CLIENT, scope: BigInt(0), actor: RELAY_CLIENT },
  audience: SERVICE_AUDIENCE,
  expiresAt: null,
  recheck: null,
};

type Run = { events: StreamEvent[]; done: Promise<unknown>; stop: () => void };

function subscribe(
  adapter: Adapter,
  principal: Principal,
  meta: Record<string, unknown> | undefined,
  cursor?: string
): Run {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  const done = createSubscriber(adapter)(
    { schema: SCHEMA, urns: [], cursor, ...(meta ? { meta } : {}) },
    {
      signal: abort.signal,
      send: async (e) => {
        events.push(e);
      },
    },
    principal
  ).catch((err: unknown) => err);
  return { events, done, stop: () => abort.abort() };
}

/** Waits until `parked` streams are parked in a poll's sleep, or `run` has ended. */
async function settle(run: Run, parked = 1) {
  let finished = false;
  void run.done.then(() => (finished = true));
  for (let i = 0; i < 5_000 && wakers.length < parked && !finished; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}
async function poll(run: Run) {
  const mark = run.events.length;
  wake();
  await settle(run);
  return run.events.slice(mark);
}
const composed = () => composeAdapter(entityStreams, publicFeed(), undefined, levelFeed());
const open = async (level: unknown, principal = servicePrincipal(LEVEL_CLIENT)) => {
  const parked = wakers.length;
  const run = subscribe(composed(), principal, { level });
  await settle(run, parked + 1);
  return run;
};
const close = async (run: Run) => {
  run.stop();
  wake();
  await run.done;
};
const upserted = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'upsert' ? [e.entity] : []));
const keysOf = (events: StreamEvent[]) => upserted(events).map((e) => e.key);
const deleted = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'delete' ? [e.urn] : []));
const metaOf = (events: StreamEvent[], type: 'live' | 'progress') =>
  events.flatMap((e) => (e.type === type ? [e.meta] : []));
const cursorOf = (events: StreamEvent[]) =>
  [...events].reverse().find((e) => 'cursor' in e && e.cursor !== '') as { cursor: string };

beforeEach(() => {
  docs = new Map();
  tombs = new Map();
  stamps = [];
  head = 0;
  markHead = 0;
  levelsOn = true;
  reads = [];
  afterChangesRead = null;
  wakers = [];
  store = createMemorySnapshotStore();
  fill = createLevelStreamFill();
});

/** One document at each selectable bit, plus every kind no bit stream may carry. */
function seedBoard() {
  put('01K0PG', { t: 'pg-doc' }, 1);
  put('01K1PG13', { t: 'pg13-doc' }, 2);
  put('01K2R', { t: 'r-doc' }, 4);
  put('01K3X', { t: 'x-doc' }, 8);
  put('01K4XXX', { t: 'xxx-doc' }, 16);
  put('01K5UNRATED', { t: 'unrated-doc' }, null);
  put('01K6BLOCKED', { t: 'blocked-doc' }, 32);
  put('01K7COUNTER', {}, null, true);
  put('01K8HIDDEN', { t: 'hidden-doc' }, 4);
  hide('01K8HIDDEN');
}

describe('routing: only an allowlisted service client naming a level is a level stream', () => {
  it('the five bit streams partition the rated board: each rated document on exactly one, the unrated, Blocked, counter and hidden on none', async () => {
    seedBoard();
    const held = new Map<number, string[]>();
    for (const bit of [1, 2, 4, 8, 16]) {
      const run = await open(bit);
      held.set(bit, keysOf(run.events) as string[]);
      await close(run);
    }
    expect(Object.fromEntries(held)).toEqual({
      1: ['01K0PG'],
      2: ['01K1PG13'],
      4: ['01K2R'],
      8: ['01K3X'],
      16: ['01K4XXX'],
    });
  });

  it('each entity carries key, body, version, timestamps, tallies and seq, never an author or marks', async () => {
    put('01K2R', { t: 'r-doc' }, 4);
    put('01K2R', { t: 'r-doc-v2' }, 4);
    vote('01K2R');
    const run = await open(4);
    const [e] = upserted(run.events);
    expect(e).toEqual({
      urn: urnOf('01K2R'),
      schemas: [SCHEMA],
      rev: expect.any(String),
      body: { t: 'r-doc-v2' },
      key: '01K2R',
      seq: 2,
      version: 2,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:02.000Z',
      tallies: { counters: {}, marks: { vote: 1 } },
    });
    await close(run);
  });

  it.each([
    ['a service client not on the allowlist', servicePrincipal(OTHER_SERVICE), { level: 4 }],
    ['a relay user token whose client is on the allowlist', relayUserPrincipal, { level: 4 }],
    ['the allowlisted client naming no level', servicePrincipal(LEVEL_CLIENT), undefined],
    [
      'the allowlisted client naming a bit no stream has',
      servicePrincipal(LEVEL_CLIENT),
      { level: 32 },
    ],
    [
      'the allowlisted client naming a level as a string',
      servicePrincipal(LEVEL_CLIENT),
      { level: '4' },
    ],
  ])('🔴 %s is routed as today, byte for byte', async (_label, principal, meta) => {
    seedBoard();
    const run = subscribe(composed(), principal, meta);
    await settle(run);
    // The same request with no level feed composed at all: today's routing.
    const today = subscribe(composeAdapter(entityStreams, publicFeed()), principal, meta);
    await settle(today, 2);
    expect(run.events.map(sseFrame)).toEqual(today.events.map(sseFrame));
    // Positive control: the public feed's own answer, a live with nothing in it.
    expect(run.events.map((e) => e.type)).toEqual(['live']);
    expect(reads).toEqual([]);
    await close(run);
    await close(today);
  });

  it('positive control: the allowlisted client naming a bit IS routed to its level stream', async () => {
    seedBoard();
    const run = await open(4);
    expect(keysOf(run.events)).toEqual(['01K2R']);
    expect(reads.slice(0, 2)).toEqual(['head', 'markHead']);
    await close(run);
  });
});

describe('levels mode: every level stream names it, and a stream that cannot be served in it ends', () => {
  it('every live and progress names levels, both heads and the approved block', async () => {
    seedBoard();
    markHead = 41;
    const run = await open(2);
    expect(metaOf(run.events, 'live')).toEqual([
      { head: { seq: 10, markSeq: 41 }, levels: 'on', block: APP_ID },
    ]);
    vote('01K1PG13');
    const batch = await poll(run);
    expect(metaOf(batch, 'progress')).toEqual([
      { head: { seq: 10, markSeq: 42 }, levels: 'on', block: APP_ID },
    ]);
    await close(run);
  });

  it('🔴 level none is refused before any snapshot while levels are on: an end naming levels_on, nothing else', async () => {
    seedBoard();
    const run = await open('none');
    await run.done;
    expect(run.events).toEqual([{ type: 'end', meta: { reason: 'levels_on', levels: 'on' } }]);
    expect(reads).toEqual([]);
  });

  it('🔴 level none with levels off is every visible non-counter document, and is ended levels_on when they turn on', async () => {
    seedBoard();
    levelsOn = false;
    const run = await open('none');
    expect((keysOf(run.events) as string[]).sort()).toEqual([
      '01K0PG',
      '01K1PG13',
      '01K2R',
      '01K3X',
      '01K4XXX',
      '01K5UNRATED',
      '01K6BLOCKED',
    ]);
    expect(metaOf(run.events, 'live')[0]).toMatchObject({ levels: 'off' });
    levelsOn = true;
    const batch = await poll(run);
    await run.done;
    expect(batch).toEqual([{ type: 'end', meta: { reason: 'levels_on', levels: 'on' } }]);
  });

  it('🔴 a bit stream is ended levels_off when levels turn off, and refused so while they are off', async () => {
    seedBoard();
    const run = await open(8);
    expect(keysOf(run.events)).toEqual(['01K3X']);
    levelsOn = false;
    const batch = await poll(run);
    await run.done;
    expect(batch).toEqual([{ type: 'end', meta: { reason: 'levels_off', levels: 'off' } }]);
    const again = await open(8);
    await again.done;
    expect(again.events).toEqual([{ type: 'end', meta: { reason: 'levels_off', levels: 'off' } }]);
  });

  it('the counters stream holds counter documents only, in either mode', async () => {
    seedBoard();
    const on = await open('counters');
    expect(keysOf(on.events)).toEqual(['01K7COUNTER']);
    expect(metaOf(on.events, 'live')[0]).toMatchObject({ levels: 'on' });
    await close(on);
    levelsOn = false;
    const off = await open('counters');
    expect(keysOf(off.events)).toEqual(['01K7COUNTER']);
    expect(metaOf(off.events, 'live')[0]).toMatchObject({ levels: 'off' });
    await close(off);
  });

  it('a collection that does not resolve ends not_resolved, never an empty board', async () => {
    // `kv` is private: no level stream.
    const priv = createSubscriber(composed());
    const events: StreamEvent[] = [];
    await priv(
      { schema: `urn:schema:apps.civitai.com:${SLUG}/kv@v1`, urns: [], meta: { level: 4 } },
      { signal: new AbortController().signal, send: async (e) => void events.push(e) },
      servicePrincipal(LEVEL_CLIENT)
    );
    expect(events).toEqual([{ type: 'end', meta: { reason: 'not_resolved' } }]);
  });
});

describe('changes on a level stream', () => {
  it('🔴 a vote moves the mark head and the tally on its document’s stream, not its seq', async () => {
    seedBoard();
    markHead = 63;
    const run = await open(4);
    const [before] = upserted(run.events);
    vote('01K2R');
    const batch = await poll(run);
    const [after] = upserted(batch);
    expect([after.key, after.seq, after.tallies]).toEqual([
      '01K2R',
      before.seq,
      { counters: {}, marks: { vote: 1 } },
    ]);
    expect(after.rev).not.toBe(before.rev);
    expect(metaOf(batch, 'progress')).toEqual([
      { head: { seq: 10, markSeq: 64 }, levels: 'on', block: APP_ID },
    ]);
    await close(run);
  });

  it('🔴 a re-rating is a Delete on the old bit’s stream and an Upsert on the new one', async () => {
    seedBoard();
    const r = await open(4);
    const x = await open(8);
    rerate('01K2R', 8);
    // One wake polls both streams.
    const [markR, markX] = [r.events.length, x.events.length];
    wake();
    await settle(r, 2);
    const fromR = r.events.slice(markR);
    const fromX = x.events.slice(markX);
    expect([deleted(fromR), keysOf(fromR)]).toEqual([[urnOf('01K2R')], []]);
    expect([deleted(fromX), keysOf(fromX)]).toEqual([[], ['01K2R']]);
    await close(r);
    await close(x);
  });

  it('🔴 a moderator hide and a delete are Deletes', async () => {
    seedBoard();
    const run = await open(1);
    put('01K9PG', { t: 'pg-doc-2' }, 1);
    expect(keysOf(await poll(run))).toEqual(['01K9PG']);
    hide('01K0PG');
    remove('01K9PG');
    expect(deleted(await poll(run))).toEqual([urnOf('01K0PG'), urnOf('01K9PG')]);
    await close(run);
  });

  it('🔴 the heads are read before the rows: a write committing mid-poll is not covered by them', async () => {
    seedBoard();
    const run = await open(16);
    put('01KAXXX', { t: 'xxx-doc-2' }, 16);
    afterChangesRead = () => {
      put('01KBXXX', { t: 'xxx-doc-3' }, 16);
      vote('01K4XXX');
    };
    reads = [];
    const batch = await poll(run);
    expect(reads.slice(0, 2)).toEqual(['head', 'markHead']);
    // What the heads name is exactly what was read: seq 11 and no vote; never the later write.
    expect(keysOf(batch)).toEqual(['01KAXXX']);
    expect(metaOf(batch, 'progress')).toEqual([
      { head: { seq: 11, markSeq: 0 }, levels: 'on', block: APP_ID },
    ]);
    // For every head sent, each write at or below it was sent.
    const next = await poll(run);
    expect(keysOf(next).sort()).toEqual(['01K4XXX', '01KBXXX']);
    expect(metaOf(next, 'progress')).toEqual([
      { head: { seq: 12, markSeq: 1 }, levels: 'on', block: APP_ID },
    ]);
    await close(run);
  });
});

describe('bindings: a level stream’s state binds its level', () => {
  it('🔴 a cursor resumed naming another bit is refused as expired, before live', async () => {
    seedBoard();
    const run = await open(4);
    const { cursor } = cursorOf(run.events);
    await close(run);
    const resumed = subscribe(composed(), servicePrincipal(LEVEL_CLIENT), { level: 8 }, cursor);
    const err = await resumed.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('cursor_expired');
    expect(resumed.events).toEqual([]);
    // Positive control: the same cursor naming its own bit resumes.
    const same = subscribe(composed(), servicePrincipal(LEVEL_CLIENT), { level: 4 }, cursor);
    await settle(same);
    expect(same.events.map((e) => e.type)).toEqual(['live']);
    await close(same);
  });

  it('🔴 a level cursor resumed without a level, or by a client off the allowlist, is refused', async () => {
    seedBoard();
    const run = await open(2);
    const { cursor } = cursorOf(run.events);
    await close(run);
    for (const [principal, meta] of [
      [servicePrincipal(LEVEL_CLIENT), undefined],
      [servicePrincipal(OTHER_SERVICE), { level: 2 }],
    ] as const) {
      const resumed = subscribe(composed(), principal, meta, cursor);
      const err = await resumed.done;
      expect((err as ProtocolError).code).toBe('cursor_expired');
    }
  });

  it('a counters cursor resumed under the other levels mode is refused as expired', async () => {
    seedBoard();
    const run = await open('counters');
    const { cursor } = cursorOf(run.events);
    await close(run);
    levelsOn = false;
    const resumed = subscribe(
      composed(),
      servicePrincipal(LEVEL_CLIENT),
      { level: 'counters' },
      cursor
    );
    expect(((await resumed.done) as ProtocolError).code).toBe('cursor_expired');
  });
});

describe('the bound: a board past it keeps each stream’s newest documents by key', () => {
  const key = (i: number) => `01KZ${String(i).padStart(6, '0')}`;
  function seedMany(n: number) {
    for (let i = 0; i < n; i++) put(key(i), { t: `doc-${i}` }, 4);
  }

  it('the bound must be strictly above the app’s own 2,000-row read', () => {
    expect(parseLevelStreamMaxRecords(undefined)).toBeGreaterThan(2_000);
    expect(parseLevelStreamMaxRecords('2001')).toBe(2_001);
    expect(() => parseLevelStreamMaxRecords('2000')).toThrow();
    expect(() => parseLevelStreamMaxRecords('1500')).toThrow();
  });

  it('🔴 past the bound: the newest by key; a delete and a re-rating inside the window backfill the next-newest from beyond it', async () => {
    seedMany(BOUND + 4);
    const run = await open(4);
    const held = keysOf(run.events) as string[];
    expect(held.length).toBe(BOUND);
    // Newest first, and exactly the newest BOUND keys.
    expect([held[0], held[held.length - 1]]).toEqual([key(BOUND + 3), key(4)]);

    remove(key(BOUND));
    const afterDelete = await poll(run);
    expect([deleted(afterDelete), keysOf(afterDelete)]).toEqual([[urnOf(key(BOUND))], [key(3)]]);

    rerate(key(17), 2);
    const afterRerate = await poll(run);
    expect([deleted(afterRerate), keysOf(afterRerate)]).toEqual([[urnOf(key(17))], [key(2)]]);

    // A document written below the window stays beyond it.
    put(key(0), { t: 'doc-0-v2' }, 4);
    expect(keysOf(await poll(run))).toEqual([]);

    // The fill: the stream is at its bound, for the 75% alert.
    const registry = new Registry();
    createLevelStreamMetrics(registry, fill);
    const text = await registry.metrics();
    expect(text).toContain('registry_adapter_level_stream_fill_ratio{level="4"} 1');
    expect(text).toContain(`registry_adapter_level_stream_records{level="4"} ${BOUND}`);
    await close(run);
    expect(await registry.metrics()).not.toContain('level="4"');
  });

  it('positive control: a board under the bound is held whole and reads below 1', async () => {
    seedMany(BOUND - 1003);
    const run = await open(4);
    expect(keysOf(run.events).length).toBe(BOUND - 1003);
    const ratio = fill.byLevel().get('4')?.ratio ?? 0;
    expect(ratio).toBeCloseTo((BOUND - 1003) / BOUND, 6);
    await close(run);
  });
});
