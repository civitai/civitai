import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, VerifiedToken, VerifyToken } from '~/server/registry-adapter/auth';
import { authenticate } from '~/server/registry-adapter/auth';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveViewerFromCatalog } from '~/server/registry-adapter/doc-streams';
import { parsePrivateRelays } from '~/server/registry-adapter/private-feed';
import type { Adapter, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import {
  bindCursor,
  createSubscriber,
  requestBinding,
} from '~/server/registry-adapter/subscription';
import type { ViewerDocSource } from '~/server/registry-adapter/viewer-feed';
import {
  DEFAULT_VIEWER_STREAM_RECORDS,
  createViewerFeed,
  parseViewerStreamMaxRecords,
  viewerStreamsOn,
} from '~/server/registry-adapter/viewer-feed';
import type {
  CollectionReadDecision,
  CollectionReadRefusal,
} from '~/server/services/apps/data-read-grant';
import type { LevelStreamDocument } from '~/server/services/apps/doc-store';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * The shared-collection PER-VIEWER STREAMS (`viewer-feed.ts`; `apps/app-data-go/WRITES-DESIGN.md`,
 * "The shape", "Authorization stays the origin's", "Bindings"), through the whole core:
 * `authenticate` over a stubbed verifier, the shared `Subscribe` core, the composed adapter and the
 * real catalog resolver, over an in-memory document store whose author arm mirrors the SQL's (the
 * SQL itself is pinned on PGlite, `doc-store.viewer-feed.pglite.test.ts`). The collection-read
 * predicate is a stub whose refusal each case sets.
 *
 * Every user, client, key, seq and level is pairwise distinct, and none equals a constant the code
 * names: the five masks a case expects (5, 15, 31, 3, 1) are each reached by exactly one token.
 */

const VIEWER = 5521;
const OTHER = 6634;
const CLIENT = 'oc-bench-3e71';
const RELAY = 'relay-data-9c04';
const UNLISTED = 'relay-main-1a88';
const APP_ID = 'apb_bench_4412';
const SLUG = 'bench-board-77';
const VOTES = `urn:schema:apps.civitai.com:${SLUG}/votes.viewer@v1`;
const RECORDS = `urn:schema:apps.civitai.com:${SLUG}/records.viewer@v1`;
const urnOf = (coll: string, key: string) => `urn:apps.civitai.com:${SLUG}/${coll}/${key}`;
const INSTALL = 'inst-bench-07d2';

type Doc = {
  coll: string;
  key: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
  /** A user id, or `counter`. */
  author: number | 'counter';
  /** The current rating; null is unrated (or pending, or stale). */
  level: number | null;
  hidden: boolean;
};
let docs: Doc[];
let head: number;
let levelsOn: boolean;
let refusal: CollectionReadRefusal | null;
let runGateReadable: boolean;
let revoked: Set<string>;
/** Every read the feed made of the source, in order, with the domain it passed. */
let reads: Array<string>;

/** REST's author arm of `sharedDocLevelVisible`, as the SQL applies it. */
const own = (d: Doc, coll: string, userId: number, domain: number | null) =>
  d.coll === coll &&
  d.author === userId &&
  !d.hidden &&
  (domain === null || d.level === null || (d.level & domain) !== 0);
const present = (d: Doc): LevelStreamDocument => ({
  key: d.key,
  data: d.data,
  version: d.version,
  seq: d.seq,
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: `2026-11-04T00:00:${String(d.version).padStart(2, '0')}.000Z`,
});
const page = (coll: string, userId: number, domain: number | null, after: string, limit: number) =>
  docs
    .filter((d) => own(d, coll, userId, domain) && d.key > after)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, limit);

const source: ViewerDocSource = {
  head: async () => {
    reads.push('head');
    return head;
  },
  versions: async (_a, coll, userId, domain, after, limit) => {
    reads.push(`versions:${domain}`);
    return page(coll, userId, domain, after, limit).map(({ key, version, seq }) => ({
      key,
      version,
      seq,
    }));
  },
  documents: async (_a, coll, userId, domain, after, limit) => {
    reads.push(`documents:${domain}`);
    return page(coll, userId, domain, after, limit).map(present);
  },
};

const put = (
  coll: string,
  key: string,
  author: number | 'counter',
  level: number | null,
  data: Record<string, unknown> = { t: `${coll}-${key}` }
) => {
  head += 1;
  const at = docs.findIndex((d) => d.coll === coll && d.key === key);
  const was = at >= 0 ? docs[at] : undefined;
  const doc = { coll, key, data, version: (was?.version ?? 0) + 1, seq: head, author, level };
  if (at >= 0) docs[at] = { ...doc, hidden: false };
  else docs.push({ ...doc, hidden: false });
};

const manifest = {
  blockId: SLUG,
  storage: {
    collections: {
      records: {
        visibility: 'shared',
        write: 'own',
        schema: { type: 'object', properties: { t: { type: 'string' } } },
      },
      votes: {
        visibility: 'shared',
        write: 'own',
        keyedBy: 'parent+viewer',
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
const decide = async (): Promise<CollectionReadDecision> =>
  refusal
    ? { ok: false, reason: refusal }
    : {
        ok: true,
        basis: 'own',
        source: {
          id: APP_ID,
          appId: CLIENT,
          manifest,
          updatedAt: null,
          collections: parseManifestStorage(manifest, APP_STORAGE_ALL_FEATURES_ON).collections,
        },
      };

let wakers: Array<() => void>;
const sleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    wakers.push(resolve);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
const wake = () => wakers.splice(0).forEach((w) => w());

let store: ReturnType<typeof createMemorySnapshotStore>;

const viewerFeed = (relays = parsePrivateRelays(RELAY), maxRecords?: number) =>
  createViewerFeed({
    relays,
    ...(maxRecords !== undefined ? { maxRecords } : {}),
    source,
    resolve: resolveViewerFromCatalog(
      async () => catalog(),
      async () => levelsOn
    ),
    decide,
    runGateReadable: async () => runGateReadable,
    instanceRevoked: async (id) => revoked.has(id),
    store,
    pollMs: 60_000,
    sleep,
  });

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
const composed = (viewer = true, maxRecords?: number) =>
  composeAdapter(
    entityStreams,
    publicFeed(),
    undefined,
    undefined,
    viewer ? viewerFeed(undefined, maxRecords) : undefined
  );

type UserToken = Extract<VerifiedToken, { userId: number }>;
const token = (over: Partial<UserToken> = {}): UserToken => ({
  subject: `user:${VIEWER}/client:${CLIENT}`,
  userId: VIEWER,
  clientId: CLIENT,
  scope: TokenScope.AppsRead | TokenScope.AppDataRead,
  actor: RELAY,
  // Settings that read every rating: the audience then holds nothing back but the region.
  user: { showNsfw: true, browsingLevel: 31 },
  expiresAt: null,
  ...over,
});
const block = (maxBrowsingLevel: number, viewerBrowsingLevel: number | null) => ({
  appBlockId: APP_ID,
  blockInstanceId: INSTALL,
  maxBrowsingLevel,
  viewerBrowsingLevel,
});
const TOKENS: Record<string, VerifiedToken> = {
  hub: token(),
  // Ceiling PG | PG13 | R | X, the viewer's own level PG | R.
  'block-exact': token({ block: block(15, 5) }),
  // The same ceiling, minted before the hub wrote the viewer's level.
  'block-interim': token({ block: block(15, null) }),
  // An SFW host's ceiling: the author's own rated documents only within PG | PG13.
  'block-sfw': token({ block: block(3, 3) }),
  // The same exact binding with another ceiling: a resume across the two is refused.
  'block-exact-other-ceiling': token({ block: block(31, 5) }),
  other: token({ subject: `user:${OTHER}/client:${CLIENT}`, userId: OTHER }),
  'no-appdataread': token({ scope: TokenScope.AppsRead }),
  'unlisted-relay': token({ actor: UNLISTED }),
};
const verify: VerifyToken = async (t) => TOKENS[t] ?? null;
const principalOf = (bearer: string | undefined, regionRestricted = false): Promise<Principal> =>
  authenticate(bearer === undefined ? undefined : `Bearer ${bearer}`, verify, {
    regionRestricted: () => regionRestricted,
  });

type Run = { events: StreamEvent[]; done: Promise<unknown>; stop: () => void };
function subscribe(
  adapter: Adapter,
  principal: Principal,
  schema = VOTES,
  cursor?: string,
  binding?: 'grpc' | 'http'
): Run {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  const done = createSubscriber(adapter, binding ? { binding } : {})(
    { schema, urns: [], cursor },
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
const open = async (bearer: string | undefined, schema = VOTES, regionRestricted = false) => {
  const parked = wakers.length;
  const run = subscribe(composed(), await principalOf(bearer, regionRestricted), schema);
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
  docs = [];
  head = 0;
  levelsOn = true;
  refusal = null;
  runGateReadable = true;
  revoked = new Set();
  reads = [];
  wakers = [];
  store = createMemorySnapshotStore();
});

/** The viewer's own votes at every rating state, and every kind of document the stream must not carry. */
function seedVotes() {
  put('votes', 'rec1:mine-pg', VIEWER, 1);
  put('votes', 'rec2:mine-r', VIEWER, 4);
  put('votes', 'rec3:mine-xxx', VIEWER, 16);
  put('votes', 'rec4:mine-unrated', VIEWER, null);
  put('votes', 'rec5:mine-blocked', VIEWER, 32);
  put('votes', 'rec6:mine-hidden', VIEWER, 1);
  docs[docs.length - 1].hidden = true;
  put('votes', 'rec7:other-pg', OTHER, 1);
  put('votes', 'rec8:counter', 'counter', null);
  // The viewer's own document of ANOTHER collection.
  put('records', 'rec9-mine', VIEWER, 2);
}

describe('what a per-viewer stream holds', () => {
  it('🔴 exactly the viewer’s own visible documents of the one collection, as REST’s author arm shows them at the domain ceiling', async () => {
    seedVotes();
    const run = await open('block-sfw');
    // Ceiling PG | PG13: the R and XXX votes are hidden from their own author on this host; the
    // unrated one is shown; Blocked, hidden, another author's and a counter document never.
    expect((keysOf(run.events) as string[]).sort()).toEqual(['rec1:mine-pg', 'rec4:mine-unrated']);
    expect(reads).toEqual(['head', 'versions:3', 'documents:3', 'head', 'versions:3']);
    await close(run);
  });

  it('🔴 each entity is a plain document under the shared document’s key URN: key, body, version, timestamps and seq', async () => {
    put('votes', 'rec1:mine-pg', VIEWER, 1, { t: 'vote-body-41' });
    put('votes', 'rec1:mine-pg', VIEWER, 1, { t: 'vote-body-42' });
    const run = await open('hub');
    const [e] = upserted(run.events);
    expect(e).toMatchObject({
      urn: urnOf('votes', 'rec1:mine-pg'),
      schemas: [`urn:schema:apps.civitai.com:${SLUG}/votes@v1`],
      body: { t: 'vote-body-42' },
      key: 'rec1:mine-pg',
      seq: 2,
      version: 2,
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:02.000Z',
    });
    expect(Object.keys(e).sort()).toEqual(
      ['body', 'createdAt', 'key', 'rev', 'schemas', 'seq', 'updatedAt', 'urn', 'version'].sort()
    );
    await close(run);
  });

  it('with content levels off, every one of the viewer’s visible documents, whatever its rating', async () => {
    seedVotes();
    levelsOn = false;
    const run = await open('block-sfw');
    expect((keysOf(run.events) as string[]).sort()).toEqual([
      'rec1:mine-pg',
      'rec2:mine-r',
      'rec3:mine-xxx',
      'rec4:mine-unrated',
      'rec5:mine-blocked',
    ]);
    expect(reads).toContain('versions:null');
    expect(metaOf(run.events, 'live')).toEqual([
      { head: { seq: 9 }, levels: 'off', keyedBy: 'parent+viewer', mask: 3 },
    ]);
    await close(run);
  });

  it('a write of the viewer’s is an Upsert at its seq, another author’s write moves only the head', async () => {
    seedVotes();
    const run = await open('hub');
    put('votes', 'rec7:other-pg-2', OTHER, 1);
    const quiet = await poll(run);
    expect(upserted(quiet)).toEqual([]);
    expect(metaOf(quiet, 'progress')).toEqual([
      { head: { seq: 10 }, levels: 'on', keyedBy: 'parent+viewer', mask: 31 },
    ]);
    put('votes', 'rec10:mine-new', VIEWER, null);
    const batch = await poll(run);
    expect(upserted(batch).map((e) => [e.key, e.seq])).toEqual([['rec10:mine-new', 11]]);
    // A delete of the viewer's own document is a Delete of its key URN.
    docs = docs.filter((d) => d.key !== 'rec1:mine-pg');
    head += 1;
    expect(deleted(await poll(run))).toEqual([urnOf('votes', 'rec1:mine-pg')]);
    await close(run);
  });
});

describe('the meta: head, levels, keyedBy and the viewer’s mask', () => {
  it.each([
    [
      'a block-exchange token with the viewer level: resolveViewerBrowsingLevel, held to the audience',
      'block-exact',
      false,
      5,
    ],
    [
      'a block-exchange token minted before the viewer level: the audience and the ceiling',
      'block-interim',
      false,
      15,
    ],
    ['a token with no block binding: the audience', 'hub', false, 31],
    ['a token with no block binding, held to SFW by its region', 'hub', true, 3],
    [
      'a block-exchange token held to SFW by its region: the exact mask ANDed with the hold',
      'block-exact',
      true,
      1,
    ],
  ])('🔴 %s', async (_label, bearer, held, mask) => {
    seedVotes();
    const run = await open(bearer, VOTES, held);
    expect(metaOf(run.events, 'live')).toEqual([
      { head: { seq: 9 }, levels: 'on', keyedBy: 'parent+viewer', mask },
    ]);
    await close(run);
  });

  it('a collection that declares no keyedBy names none', async () => {
    seedVotes();
    const run = await open('hub', RECORDS);
    expect(keysOf(run.events)).toEqual(['rec9-mine']);
    expect(metaOf(run.events, 'live')).toEqual([{ head: { seq: 9 }, levels: 'on', mask: 31 }]);
    await close(run);
  });

  it('🔴 the head is read before the rows', async () => {
    seedVotes();
    const run = await open('hub');
    expect(reads.slice(0, 3)).toEqual(['head', 'versions:31', 'documents:31']);
    await close(run);
  });
});

describe('an explicit refusal: no mask, nothing held, never an empty stream with a mask', () => {
  it.each([
    ['an unlisted relay', 'unlisted-relay'],
    ['a token without AppDataRead', 'no-appdataread'],
    ['no token at all', undefined],
  ])(
    '🔴 %s: refused by the token gate before ANY read (catalog, flag, head), so live names no mask, no head, no levels',
    async (_label, bearer) => {
      seedVotes();
      let catalogReads = 0;
      let flagReads = 0;
      const feed = createViewerFeed({
        relays: parsePrivateRelays(RELAY),
        source,
        resolve: resolveViewerFromCatalog(
          async () => {
            catalogReads += 1;
            return catalog();
          },
          async () => {
            flagReads += 1;
            return levelsOn;
          }
        ),
        decide,
        runGateReadable: async () => runGateReadable,
        instanceRevoked: async (id) => revoked.has(id),
        store,
        pollMs: 60_000,
        sleep,
      });
      const run = subscribe(
        composeAdapter(entityStreams, publicFeed(), undefined, undefined, feed),
        await principalOf(bearer)
      );
      await settle(run, 1);
      expect(upserted(run.events)).toEqual([]);
      // As the private feed: the token gate runs first, so a token that may read no per-viewer
      // stream costs no catalog, flag or head lookup, and its meta carries nothing it read.
      expect(metaOf(run.events, 'live')).toEqual([{}]);
      expect(reads).toEqual([]);
      expect([catalogReads, flagReads]).toEqual([0, 0]);
      // And on every poll after it.
      expect(await poll(run)).toEqual([]);
      expect(reads).toEqual([]);
      expect([catalogReads, flagReads]).toEqual([0, 0]);
      await close(run);
    }
  );

  it('🔴 a predicate refusal and a revoked install send no mask and Delete what was held; admitted again, the mask and the documents come back', async () => {
    seedVotes();
    const run = await open('block-exact');
    const held = (keysOf(run.events) as string[]).sort();
    expect(held).toEqual(['rec1:mine-pg', 'rec2:mine-r', 'rec4:mine-unrated']);
    revoked.add(INSTALL);
    const refused = await poll(run);
    expect(deleted(refused).sort()).toEqual(held.map((k) => urnOf('votes', k)).sort());
    expect(metaOf(refused, 'progress')).toEqual([
      { head: { seq: 9 }, levels: 'on', keyedBy: 'parent+viewer' },
    ]);
    revoked.clear();
    const back = await poll(run);
    expect((keysOf(back) as string[]).sort()).toEqual(held);
    expect(metaOf(back, 'progress')).toEqual([
      { head: { seq: 9 }, levels: 'on', keyedBy: 'parent+viewer', mask: 5 },
    ]);
    refusal = 'token_block_not_approved';
    const again = await poll(run);
    expect(deleted(again).length).toBe(3);
    expect(metaOf(again, 'progress')).toEqual([
      { head: { seq: 9 }, levels: 'on', keyedBy: 'parent+viewer' },
    ]);
    await close(run);
  });

  it('🔴 a cursor resumed after a refusal is refused at live, never served one poll on the old mask', async () => {
    seedVotes();
    const run = await open('hub');
    const { cursor } = cursorOf(run.events);
    await close(run);
    refusal = 'apps_disabled';
    const resumed = subscribe(composed(), await principalOf('hub'), VOTES, cursor);
    await settle(resumed, wakers.length + 1);
    expect(metaOf(resumed.events, 'live')).toEqual([
      { head: { seq: 9 }, levels: 'on', keyedBy: 'parent+viewer' },
    ]);
    await close(resumed);
  });

  it('an apps_disabled refusal while the run gate cannot be read is unavailable, never a refusal', async () => {
    seedVotes();
    refusal = 'apps_disabled';
    runGateReadable = false;
    const run = subscribe(composed(), await principalOf('hub'));
    const err = await run.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('unavailable');
    expect(run.events).toEqual([]);
  });
});

describe('not resolved, off, and the gRPC binding', () => {
  it.each([
    ['a private collection', `urn:schema:apps.civitai.com:${SLUG}/kv.viewer@v1`],
    ['an unknown app', 'urn:schema:apps.civitai.com:no-such-app-31/votes.viewer@v1'],
    ['a major not minted', `urn:schema:apps.civitai.com:${SLUG}/votes.viewer@v4`],
  ])('🔴 %s ends not_resolved, never an empty stream', async (_label, schema) => {
    const run = subscribe(composed(), await principalOf('hub'), schema);
    await run.done;
    expect(run.events).toEqual([{ type: 'end', meta: { reason: 'not_resolved' } }]);
  });

  it('🔴 off (no viewer feed composed): a per-viewer URN is not served, a bare end', async () => {
    seedVotes();
    const run = subscribe(composed(false), await principalOf('hub'));
    await run.done;
    expect(run.events).toEqual([{ type: 'end' }]);
    expect(reads).toEqual([]);
    // Positive control: composed, the same subscription is served.
    const on = await open('hub');
    expect(keysOf(on.events).length).toBe(4);
    await close(on);
  });

  it('REGISTRY_ADAPTER_VIEWER_STREAMS is on for exactly `1`', () => {
    expect([undefined, '', '0', 'true', ' 1'].map(viewerStreamsOn)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(viewerStreamsOn('1')).toBe(true);
  });

  it('🔴 a per-viewer subscription on the gRPC binding is refused as bad_request, before any read', async () => {
    seedVotes();
    const run = subscribe(composed(), await principalOf('hub'), VOTES, undefined, 'grpc');
    const err = await run.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('bad_request');
    expect(run.events).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe('the bound: a per-viewer stream past maxRecords ends too_large, never a truncated set', () => {
  /** `n` of the viewer's own unrated votes, keys sorting in order. */
  const seedMine = (n: number) => {
    for (let i = 0; i < n; i++) put('votes', `bound-${String(i).padStart(5, '0')}`, VIEWER, null);
  };

  it('🔴 one past the bound ends the snapshot too_large; exactly at it, every document is served', async () => {
    // A bound that is not a multiple of the page (500), so the last page is cut by the bound.
    const BOUND = 1_237;
    seedMine(BOUND);
    const at = subscribe(composed(true, BOUND), await principalOf('hub'));
    await settle(at, 1);
    expect(keysOf(at.events).length).toBe(BOUND);
    await close(at);

    put('votes', 'bound-99999', VIEWER, null);
    reads = [];
    const over = subscribe(composed(true, BOUND), await principalOf('hub'));
    await over.done;
    expect(over.events).toEqual([{ type: 'end', meta: { reason: 'too_large' } }]);
    // It read the versions up to one row past the bound (pages of 500, 500, then 238) and stopped
    // there: no document body was read.
    expect(reads).toEqual(['head', 'versions:31', 'versions:31', 'versions:31']);
  });

  it('🔴 a live stream that grows past the bound ends too_large on its next poll', async () => {
    const BOUND = 613;
    seedMine(BOUND);
    const run = subscribe(composed(true, BOUND), await principalOf('hub'));
    await settle(run, 1);
    expect(keysOf(run.events).length).toBe(BOUND);
    put('votes', 'bound-99999', VIEWER, null);
    wake();
    await run.done;
    expect(run.events[run.events.length - 1]).toEqual({
      type: 'end',
      meta: { reason: 'too_large' },
    });
  });

  it('the default bound is far above every tier’s default quota; the env must be above it', () => {
    expect(parseViewerStreamMaxRecords(undefined)).toBe(20_000);
    expect(parseViewerStreamMaxRecords('')).toBe(20_000);
    expect(DEFAULT_VIEWER_STREAM_RECORDS).toBe(20_000);
    expect(parseViewerStreamMaxRecords('25000')).toBe(25_000);
    for (const bad of ['10000', '999', '-1', '2.5e4x', 'many', '20000.5']) {
      expect(() => parseViewerStreamMaxRecords(bad)).toThrow(
        'REGISTRY_ADAPTER_VIEWER_STREAM_MAX_RECORDS must be an integer above 10000'
      );
    }
  });
});

describe('bindings: a per-viewer cursor binds its schema, subject, audience and level binding', () => {
  it('🔴 a cursor resumed by ANOTHER user’s token (same audience, same binding) is refused as expired, before live', async () => {
    // seedVotes holds a vote of OTHER's, so a resume served under OTHER would have one to send.
    seedVotes();
    const run = await open('hub');
    const { cursor } = cursorOf(run.events);
    await close(run);
    // The request binding (`subscription.ts`) is a public digest that names the subject, so a holder
    // of another's cursor re-binds it to their own subject: only the stored state's subject check
    // can refuse it. Without the re-bind the core's binding check refuses first, and this case
    // would never reach the feed's.
    const otherPrincipal = await principalOf('other');
    const inner = cursor.replace(/^b1\.[0-9a-f]+\./, '');
    expect(inner).not.toBe(cursor);
    const rebound = bindCursor(
      inner,
      requestBinding({ schema: VOTES, urns: [] }, otherPrincipal.subject)
    );
    const other = subscribe(composed(), otherPrincipal, VOTES, rebound);
    const err = await other.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('cursor_expired');
    expect((err as ProtocolError).message).toBe('the cursor was issued to another token subject');
    expect(other.events).toEqual([]);
    // Positive control: OTHER's own fresh subscription is served, and the viewer's cursor resumes.
    const fresh = await open('other');
    expect(keysOf(fresh.events)).toEqual(['rec7:other-pg']);
    await close(fresh);
    const same = subscribe(composed(), await principalOf('hub'), VOTES, cursor);
    await settle(same, wakers.length + 1);
    expect(same.events.map((e) => e.type)).toEqual(['live']);
    await close(same);
  });

  it('🔴 a cursor resumed with another ceiling is refused as expired, before live; its own token resumes', async () => {
    seedVotes();
    const run = await open('block-exact');
    const { cursor } = cursorOf(run.events);
    await close(run);
    const other = subscribe(
      composed(),
      await principalOf('block-exact-other-ceiling'),
      VOTES,
      cursor
    );
    const err = await other.done;
    expect((err as ProtocolError).code).toBe('cursor_expired');
    expect(other.events).toEqual([]);
    const same = subscribe(composed(), await principalOf('block-exact'), VOTES, cursor);
    await settle(same, wakers.length + 1);
    expect(same.events.map((e) => e.type)).toEqual(['live']);
    await close(same);
  });

  it('🔴 a per-viewer cursor on another collection’s per-viewer URN, or a collection-schema URN, is refused', async () => {
    seedVotes();
    const run = await open('hub');
    const { cursor } = cursorOf(run.events);
    await close(run);
    for (const schema of [RECORDS, `urn:schema:apps.civitai.com:${SLUG}/votes@v1`]) {
      const resumed = subscribe(composed(), await principalOf('hub'), schema, cursor);
      const err = await resumed.done;
      expect((err as ProtocolError).code).toBe('cursor_expired');
    }
  });
});
