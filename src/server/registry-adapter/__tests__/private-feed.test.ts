import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { Principal, VerifiedToken, VerifyToken } from '~/server/registry-adapter/auth';
import { authenticate } from '~/server/registry-adapter/auth';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { createDocFeed, docRev } from '~/server/registry-adapter/doc-feed';
import { sha256Hex, sortedKeyJson } from '~/server/registry-adapter/release';
import { composeAdapter, resolvePrivateFromCatalog } from '~/server/registry-adapter/doc-streams';
import {
  PRIVATE_CURSOR_TTL_MS,
  createPrivateDocFeed,
  parsePrivateRelays,
  privateTokenGate,
} from '~/server/registry-adapter/private-feed';
import type { Adapter, StreamEvent } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import {
  bindCursor,
  createSubscriber,
  requestBinding,
  unbindCursor,
} from '~/server/registry-adapter/subscription';
import { createCollectionReadDecider } from '~/server/services/apps/data-read-grant';
import type { PrivateFeedDocument } from '~/server/services/apps/doc-store';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Registry } from 'prom-client';
import {
  createEnforceMetrics,
  createPolicyEnforcer,
} from '~/server/registry-adapter/policy-enforce';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * 🔴 LEAK CANARIES for authorized private streams (`private-feed.ts`), through the whole path a
 * subscription takes: `authenticate` over a stubbed token verifier, the shared `Subscribe` core,
 * the composed adapter (public feed + private feed), and THE collection-read predicate itself
 * (`createCollectionReadDecider`, the real rule over a stubbed database, as
 * `data-read-grant.test.ts` drives it; only the run gate is passed in).
 *
 * Every user, client, relay, app id, record id and canary string is pairwise distinct, and none
 * equals a constant the code names. Each refusal case has a positive control: the owner (own
 * client) and the grantee (consumer client with a grant) DO receive the canary through the same
 * harness.
 */

const OWNER = 7741;
const OTHER = 8862;
const SOURCE_CLIENT = 'oc-src-41d7';
const CONSUMER_CLIENT = 'oc-con-9b02';
const SERVICE_CLIENT = 'svc-index-77aa';
const RELAY = 'relay-exp-5c31';
const UNLISTED_RELAY = 'relay-main-0d77';
const SOURCE_ID = 'apb_src_7731';
const SOURCE_BLOCK = 'notes-hub-2264';
const CONSUMER_ID = 'apb_con_5590';
const SCHEMA = `urn:schema:apps.civitai.com:${SOURCE_BLOCK}/journal@v1`;
const OWNER_CANARY = 'OWNER-PRIVATE-CANARY-a91f';
const OWNER_CANARY_2 = 'OWNER-PRIVATE-CANARY-2-c04e';
const OTHER_CANARY = 'OTHER-USER-CANARY-b27d';
const OWNER_RECORD = '3f9c1a52-7b0e-4d61-9a2f-0c8e5b7d1a43';
const OWNER_RECORD_2 = '8a2d4e61-1c3b-4f7a-b5e9-6d0f2a8c3b17';
const OTHER_RECORD = 'c5e8f3a1-9d2b-4e70-8f16-3a7b0d5c9e24';
const OWNER_URN = `urn:apps.civitai.com:${SOURCE_BLOCK}/journal/${OWNER_RECORD}`;
const OWNER_URN_2 = `urn:apps.civitai.com:${SOURCE_BLOCK}/journal/${OWNER_RECORD_2}`;
const INSTALL_SFW = 'inst-own-sfw-3d71';
const INSTALL_XXX = 'inst-own-xxx-58a0';
const INSTALL_CON_SFW = 'inst-con-sfw-0b94';
const INSTALL_CON_XXX = 'inst-con-xxx-e612';

/** The source app's content rating: PG-13 unless a case sets a mature one. */
let sourceRating: string;

const sourceManifest = () => ({
  contentRating: sourceRating,
  scopes: ['apps:storage'],
  storage: {
    collections: {
      journal: {
        visibility: 'private',
        schema: { type: 'object', properties: { t: { type: 'string' } } },
      },
    },
  },
});
const consumerManifest = () => ({
  scopes: ['apps:storage', 'apps:storage:import'],
  storage: {
    collections: { scratch: { visibility: 'private' } },
    imports: [{ from: SOURCE_BLOCK, collections: ['journal'], access: 'read' }],
  },
});

type Row = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let rows: Row[];
let ledgerScopes: string[] | null;
let grantRow: { collections: string[]; access: 'read' | 'readwrite' } | null;
const runGate = vi.fn<(userId: number) => Promise<void>>();
const decide = createCollectionReadDecider({ assertMayRunApps: runGate });

/** The private documents, per (app, collection, user). */
let docs: Map<string, PrivateFeedDocument[]>;
const docsKey = (appId: string, coll: string, userId: number) => `${appId}|${coll}|${userId}`;
const page = (appId: string, coll: string, userId: number, afterKey: string, limit: number) =>
  (docs.get(docsKey(appId, coll, userId)) ?? [])
    .filter((d) => d.key > afterKey)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, limit);

const catalog = (): CatalogApp[] => [
  {
    listing: {
      slug: SOURCE_BLOCK,
      kind: 'onsite',
      name: 'Notes Hub',
      tagline: null,
      category: null,
      contentRating: sourceRating,
      iconUrl: null,
      creatorUsername: null,
      externalUrl: null,
      sourceRepoUrl: null,
      forkOf: null,
    },
    block: {
      id: SOURCE_ID,
      blockId: SOURCE_BLOCK,
      version: '1.0.0',
      status: 'approved',
      contentRating: sourceRating,
      manifest: sourceManifest(),
    },
    approved: [],
  },
];

/** The poll's sleep: each poll waits for {@link wake}. */
let wakers: Array<() => void>;
const sleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    wakers.push(resolve);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
const wake = () => wakers.splice(0).forEach((w) => w());

/** Whether the run gate's flag reads (false: a Flipt outage, when the gate refuses everyone). */
let runGateReadable: boolean;
/** The installs whose revocation markers are set (uninstalled, turned off, publisher banned). */
let revokedInstalls: Set<string>;
/** Every install-revocation read: [blockInstanceId, userId]. */
let revocationReads: Array<[string, number]>;
let now: number;
let store: ReturnType<typeof createMemorySnapshotStore>;
/** The app namespace's write head the source answers. */
let head: number;
/** Every read the feed made of the source, in order. */
let reads: Array<'head' | 'versions' | 'documents'>;
/** Run once, after the next `documents` read returns: a write that commits right after the keyset. */
let afterDocumentsRead: (() => void) | null;

function privateFeed(relays = parsePrivateRelays(RELAY)) {
  return createPrivateDocFeed({
    relays,
    source: {
      head: async () => {
        reads.push('head');
        return head;
      },
      versions: async (...a) => {
        reads.push('versions');
        return page(...a);
      },
      documents: async (...a) => {
        reads.push('documents');
        const out = page(...a);
        const write = afterDocumentsRead;
        afterDocumentsRead = null;
        write?.();
        return out;
      },
    },
    resolve: resolvePrivateFromCatalog(async () => catalog()),
    decide,
    runGateReadable: async () => runGateReadable,
    instanceRevoked: async (blockInstanceId, userId) => {
      revocationReads.push([blockInstanceId, userId]);
      return revokedInstalls.has(blockInstanceId);
    },
    store,
    pollMs: 60_000,
    sleep,
    now: () => now,
  });
}

/** The public feed, over a store that holds nothing public: the private collection's public stream. */
const publicFeed = () =>
  createDocFeed({
    source: {
      head: async () => 0,
      changes: async () => ({ docs: [], tombs: [] }),
      documents: async () => [],
      witness: async () => ({ docSeq: null, tombSeq: null }),
    },
    resolve: async () => null,
    store: createMemorySnapshotStore(),
    pollMs: 60_000,
    sleep,
  });

const entities: Adapter = {
  namespace: 'apps.civitai.com',
  serves: () => false,
  snapshot: async () => ({ cursor: '', entities: [] }),
  // Never reached: these cases subscribe to a document stream only.
  changes: async () => {
    throw new Error('the entity streams are not under test');
  },
};

const ALL_READ = TokenScope.AppsRead | TokenScope.AppDataRead;
type UserToken = Extract<VerifiedToken, { userId: number }>;
const token = (over: Partial<UserToken>): UserToken => ({
  subject: `user:${OWNER}/client:${SOURCE_CLIENT}`,
  userId: OWNER,
  clientId: SOURCE_CLIENT,
  scope: ALL_READ,
  actor: RELAY,
  user: { showNsfw: false, browsingLevel: 1 },
  expiresAt: null,
  ...over,
});
const userToken = (userId: number, clientId: string, over: Partial<UserToken> = {}) =>
  token({ subject: `user:${userId}/client:${clientId}`, userId, clientId, ...over });

/** Every bearer this suite presents, by its literal. */
const TOKENS: Record<string, VerifiedToken> = {
  'owner-own': userToken(OWNER, SOURCE_CLIENT),
  'owner-grantee': userToken(OWNER, CONSUMER_CLIENT),
  'other-own': userToken(OTHER, SOURCE_CLIENT),
  'other-grantee': userToken(OTHER, CONSUMER_CLIENT),
  // A service's own token, as an allowlisted service client presents it (`auth.jwt.ts`): no user.
  service: {
    subject: `service:${SERVICE_CLIENT}`,
    userId: null,
    clientId: SERVICE_CLIENT,
    scope: ALL_READ,
    actor: RELAY,
    service: true,
    expiresAt: null,
  },
  'owner-no-appdataread': userToken(OWNER, SOURCE_CLIENT, { scope: TokenScope.AppsRead }),
  'owner-unlisted-relay': userToken(OWNER, SOURCE_CLIENT, { actor: UNLISTED_RELAY }),
  'owner-no-relay': userToken(OWNER, SOURCE_CLIENT, { actor: null }),
  // The owner with settings that read every rating, for the content-policy enforcement seam.
  'owner-r-only': userToken(OWNER, SOURCE_CLIENT, { user: { showNsfw: true, browsingLevel: 7 } }),
  'owner-full': userToken(OWNER, SOURCE_CLIENT, { user: { showNsfw: true, browsingLevel: 31 } }),
  // Block-exchange tokens (`auth.jwt.ts` → `VerifiedToken.block`): the owner with settings that read
  // every rating, holding a token minted on an SFW host (ceiling PG | PG13 = 3) or on the mature-capable
  // host (every level = 31), through the source app's own client or the importing consumer's.
  'owner-own-block-sfw': userToken(OWNER, SOURCE_CLIENT, {
    user: { showNsfw: true, browsingLevel: 31 },
    block: { appBlockId: SOURCE_ID, blockInstanceId: INSTALL_SFW, maxBrowsingLevel: 3 },
  }),
  'owner-own-block-xxx': userToken(OWNER, SOURCE_CLIENT, {
    user: { showNsfw: true, browsingLevel: 31 },
    block: { appBlockId: SOURCE_ID, blockInstanceId: INSTALL_XXX, maxBrowsingLevel: 31 },
  }),
  'owner-grantee-block-sfw': userToken(OWNER, CONSUMER_CLIENT, {
    user: { showNsfw: true, browsingLevel: 31 },
    block: { appBlockId: CONSUMER_ID, blockInstanceId: INSTALL_CON_SFW, maxBrowsingLevel: 3 },
  }),
  'owner-grantee-block-xxx': userToken(OWNER, CONSUMER_CLIENT, {
    user: { showNsfw: true, browsingLevel: 31 },
    block: { appBlockId: CONSUMER_ID, blockInstanceId: INSTALL_CON_XXX, maxBrowsingLevel: 31 },
  }),
  // A user-exchange token for the same user, client and settings: no block binding.
  'owner-grantee-full': userToken(OWNER, CONSUMER_CLIENT, {
    user: { showNsfw: true, browsingLevel: 31 },
  }),
};
const verify: VerifyToken = async (t) => TOKENS[t] ?? null;
const principalOf = (bearer: string | undefined): Promise<Principal> =>
  authenticate(bearer === undefined ? undefined : `Bearer ${bearer}`, verify, {
    regionRestricted: () => false,
  });

type Run = { events: StreamEvent[]; done: Promise<unknown>; stop: () => void };

/** One subscription through the whole core; `stop` aborts it. */
function subscribe(adapter: Adapter, principal: Principal, cursor?: string): Run {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  const sub = createSubscriber(adapter);
  const done = sub(
    { schema: SCHEMA, urns: [], cursor },
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

/** Waits until the stream is parked in a poll's sleep (or has ended). */
async function settle(run: Run) {
  for (let i = 0; i < 50 && wakers.length === 0; i++) {
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 1))]);
  }
}

/** A snapshot to `live`, then stopped: every event it sent, or the error it ended with. */
async function snapshotOf(
  bearer: string | undefined,
  adapter = composeAdapter(entities, publicFeed(), privateFeed())
) {
  const run = subscribe(adapter, await principalOf(bearer));
  await settle(run);
  run.stop();
  wake();
  const err = await run.done;
  return { events: run.events, err };
}

const upserts = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'upsert' ? [e.entity.urn] : []));

beforeEach(() => {
  sourceRating = 'pg13';
  now = Date.UTC(2026, 10, 19, 12);
  runGateReadable = true;
  revokedInstalls = new Set();
  revocationReads = [];
  wakers = [];
  store = createMemorySnapshotStore();
  head = 97;
  reads = [];
  afterDocumentsRead = null;
  rows = [
    {
      id: SOURCE_ID,
      appId: SOURCE_CLIENT,
      blockId: SOURCE_BLOCK,
      status: 'approved',
      manifest: sourceManifest(),
    },
    {
      id: CONSUMER_ID,
      appId: CONSUMER_CLIENT,
      blockId: 'reader-app-8143',
      status: 'approved',
      manifest: consumerManifest(),
    },
  ];
  dbMock.dbRead.appBlock.findUnique.mockImplementation(
    async ({ where }: { where: { blockId: string } }) =>
      rows.find((r) => r.blockId === where.blockId) ?? null
  );
  dbMock.dbRead.appBlock.findMany.mockImplementation(
    async ({ where }: { where: { appId: string; status: string } }) =>
      rows.filter((r) => r.appId === where.appId && r.status === where.status)
  );
  runGate.mockReset().mockResolvedValue(undefined);
  // The OWNER granted the consumer the import; OTHER granted nothing.
  ledgerScopes = ['apps:storage', 'apps:storage:import'];
  grantRow = { collections: ['journal'], access: 'read' };
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockImplementation(
    async ({ where }: { where: { userId_appBlockId?: { userId: number } } }) => {
      const uid = where.userId_appBlockId?.userId;
      return ledgerScopes && uid === OWNER
        ? { grantedScopes: ledgerScopes, revokedAt: null, revokedScopes: [] }
        : null;
    }
  );
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join('?').includes('app_storage_import_grants')) return [];
      return grantRow && values.includes(OWNER)
        ? [{ sourceAppBlockId: SOURCE_ID, ...grantRow }]
        : [];
    }
  );
  docs = new Map([
    [
      docsKey(SOURCE_ID, 'journal', OWNER),
      [{ key: 'entry-1', recordId: OWNER_RECORD, version: 3, seq: 41, data: { t: OWNER_CANARY } }],
    ],
    [
      docsKey(SOURCE_ID, 'journal', OTHER),
      [{ key: 'entry-1', recordId: OTHER_RECORD, version: 5, seq: 57, data: { t: OTHER_CANARY } }],
    ],
  ]);
});

describe('🔴 leak canaries: who receives a private record', () => {
  it("POSITIVE CONTROL: the owner, through the app's own client and a listed relay, receives it", async () => {
    const { events, err } = await snapshotOf('owner-own');
    expect(err).toBeUndefined();
    expect(upserts(events)).toEqual([OWNER_URN]);
    expect(JSON.stringify(events)).toContain(OWNER_CANARY);
    expect(events.map((e) => e.type)).toEqual(['upsert', 'live']);
  });

  it('POSITIVE CONTROL: a grantee app the owner granted the import receives it', async () => {
    const { events } = await snapshotOf('owner-grantee');
    expect(upserts(events)).toEqual([OWNER_URN]);
    expect(JSON.stringify(events)).toContain(OWNER_CANARY);
  });

  it("a non-owner user, through the same app, receives only their own record, never the owner's", async () => {
    const { events } = await snapshotOf('other-own');
    expect(JSON.stringify(events)).not.toContain(OWNER_CANARY);
    expect(JSON.stringify(events)).not.toContain(OWNER_RECORD);
    // Their own record (a positive control on the same token shape).
    expect(JSON.stringify(events)).toContain(OTHER_CANARY);
  });

  // Each refused subscriber: an empty snapshot and `live`, with no record of anyone's.
  it.each([
    ['a non-grantee (an app the user never granted the import)', 'other-grantee'],
    ['a service token (no user)', 'service'],
    ['an anonymous subscriber (no token)', undefined],
    ['a token without AppDataRead', 'owner-no-appdataread'],
    ['a token relayed by a relay not on the list', 'owner-unlisted-relay'],
    ['a token no relay exchanged (no act.sub)', 'owner-no-relay'],
  ])('🔴 %s receives ZERO private records', async (_label, bearer) => {
    const { events, err } = await snapshotOf(bearer);
    expect(err).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['live']);
    for (const canary of [OWNER_CANARY, OTHER_CANARY, OWNER_RECORD, OTHER_RECORD]) {
      expect(JSON.stringify(events)).not.toContain(canary);
    }
  });

  it('🔴 with no relay listed (the default), the owner receives nothing: private streams do not exist', async () => {
    // As `main.ts` builds it with REGISTRY_ADAPTER_PRIVATE_RELAYS unset: no private feed at all.
    const off = await snapshotOf('owner-own', composeAdapter(entities, publicFeed()));
    expect(off.events.map((e) => e.type)).toEqual(['live']);
    expect(JSON.stringify(off.events)).not.toContain(OWNER_CANARY);
    // And an empty list, had one been built anyway, admits no relay.
    const empty = await snapshotOf(
      'owner-own',
      composeAdapter(entities, publicFeed(), privateFeed(parsePrivateRelays('')))
    );
    expect(JSON.stringify(empty.events)).not.toContain(OWNER_CANARY);
    expect(parsePrivateRelays(undefined).size).toBe(0);
    expect(parsePrivateRelays(' ,  ').size).toBe(0);
    expect([...parsePrivateRelays(`${RELAY}, ${UNLISTED_RELAY}`)]).toEqual([RELAY, UNLISTED_RELAY]);
  });

  it("🔴 with only the experimental relay's client listed, a token the main gateway exchanged receives ZERO", async () => {
    // Synthetic stand-ins for the two relays' hub clients; the property does not depend on them.
    const EXP = '00000000-0000-4000-8000-0000000e0e01';
    const MAIN_GATEWAY = '00000000-0000-4000-8000-00000a1a0002';
    const adapter = () =>
      composeAdapter(entities, publicFeed(), privateFeed(parsePrivateRelays(EXP)));
    TOKENS['owner-via-main'] = userToken(OWNER, SOURCE_CLIENT, { actor: MAIN_GATEWAY });
    TOKENS['owner-via-exp'] = userToken(OWNER, SOURCE_CLIENT, { actor: EXP });
    try {
      const viaMain = await snapshotOf('owner-via-main', adapter());
      expect(viaMain.events.map((e) => e.type)).toEqual(['live']);
      expect(JSON.stringify(viaMain.events)).not.toContain(OWNER_CANARY);
      // POSITIVE CONTROL: the same user, app and token shape through the listed relay.
      const viaExp = await snapshotOf('owner-via-exp', adapter());
      expect(upserts(viaExp.events)).toEqual([OWNER_URN]);
    } finally {
      delete TOKENS['owner-via-main'];
      delete TOKENS['owner-via-exp'];
    }
  });

  it('the token gate refuses in order: anonymous, not a user, relay not listed, scope missing', () => {
    const relays = parsePrivateRelays(RELAY);
    const reader = (t: VerifiedToken) => ({ ...t, subject: t.subject });
    expect(privateTokenGate(relays, null)).toBe('anonymous');
    expect(privateTokenGate(relays, reader(TOKENS.service))).toBe('not_user');
    // A service token from an unlisted relay with no scope still names the FIRST refusal.
    expect(
      privateTokenGate(relays, reader({ ...TOKENS.service, actor: UNLISTED_RELAY, scope: 0n }))
    ).toBe('not_user');
    expect(privateTokenGate(relays, reader(TOKENS['owner-unlisted-relay']))).toBe(
      'relay_not_listed'
    );
    expect(privateTokenGate(relays, reader(TOKENS['owner-no-appdataread']))).toBe('scope_missing');
    expect(privateTokenGate(relays, reader(TOKENS['owner-own']))).toBeNull();
  });
});

describe('🔴 content-policy enforcement reaches the private feed (policy-enforce.ts)', () => {
  /** An enforcer whose service answers R and below: narrower than a full user's own settings. */
  const narrowing = createPolicyEnforcer({
    compare: async () => ({
      result: 'disagree',
      answer: { ratings: ['g', 'pg', 'pg13', 'r'], unknownRating: false, regionHold: 'none' },
    }),
    counter: createEnforceMetrics(new Registry()),
    log: () => undefined,
  });
  const enforced = async (bearer: string) =>
    narrowing({
      origin: { headers: { 'cf-ipcountry': 'NL' } },
      principal: await principalOf(bearer),
      held: false,
    });
  /** The source app rated `rating` everywhere the feed reads it: the catalog and its DB row. */
  const rateSource = (rating: string) => {
    sourceRating = rating;
    rows[0].manifest = sourceManifest();
  };
  const snapshotFor = async (principal: Principal) => {
    const run = subscribe(composeAdapter(entities, publicFeed(), privateFeed()), principal);
    await settle(run);
    run.stop();
    wake();
    const err = await run.done;
    return { events: run.events, err };
  };

  it('POSITIVE CONTROL: unenforced, the full owner receives an X-rated app’s private record', async () => {
    rateSource('x');
    const { events, err } = await snapshotFor(await principalOf('owner-full'));
    expect(err).toBeUndefined();
    expect(upserts(events)).toEqual([OWNER_URN]);
  });

  it('control: unenforced, an owner whose own settings leave out X is not sent it either', async () => {
    rateSource('x');
    const p = await principalOf('owner-r-only');
    const { events } = await snapshotFor(p);
    expect({ key: p.audience.key, urns: upserts(events) }).toEqual({ key: 'mr', urns: [] });
  });

  it('a service answer without X withholds the same record: the feed reads the enforced audience', async () => {
    rateSource('x');
    const principal = await enforced('owner-full');
    expect(principal.audience.key).toBe('mr');
    const { events, err } = await snapshotFor(principal);
    expect(err).toBeUndefined();
    expect(upserts(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(OWNER_CANARY);
  });
});

describe('🔴 revocation and deletion leave the stream as Deletes', () => {
  /** A live grantee stream, past its snapshot, parked in its first poll's sleep. */
  async function liveStream(bearer: string) {
    const run = subscribe(
      composeAdapter(entities, publicFeed(), privateFeed()),
      await principalOf(bearer)
    );
    await settle(run);
    expect(upserts(run.events)).toEqual([OWNER_URN]);
    return run;
  }
  /** One poll: wake the stream, and wait until it is parked again. */
  async function poll(run: Run) {
    wake();
    await settle(run);
  }
  const deletes = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === 'delete' ? [e.urn] : []));

  it('a revoked import grant: the next poll sends a Delete for the record', async () => {
    const run = await liveStream('owner-grantee');
    grantRow = null;
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    run.stop();
    wake();
  });

  it('the import scope withdrawn: a Delete', async () => {
    const run = await liveStream('owner-grantee');
    ledgerScopes = ['apps:storage'];
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    run.stop();
    wake();
  });

  it("the user may no longer run apps: a Delete, on the owner's own stream too", async () => {
    const run = await liveStream('owner-own');
    runGate.mockRejectedValue(new (await import('@trpc/server')).TRPCError({ code: 'FORBIDDEN' }));
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    run.stop();
    wake();
  });

  it('🔴 the run gate unreadable (a Flipt outage): the stream ends unavailable, with zero Deletes', async () => {
    const run = await liveStream('owner-own');
    // What the run gate does while its flag cannot be read: it refuses everyone.
    runGate.mockRejectedValue(
      new (await import('@trpc/server')).TRPCError({ code: 'UNAUTHORIZED' })
    );
    runGateReadable = false;
    await poll(run);
    expect(deletes(run.events)).toEqual([]);
    const err = await run.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('unavailable');
    expect((err as ProtocolError).message).toBe('the App Blocks run gate cannot be read');
  });

  it('🔴 a snapshot while the run gate is unreadable is unavailable, not an empty stream', async () => {
    runGate.mockRejectedValue(
      new (await import('@trpc/server')).TRPCError({ code: 'UNAUTHORIZED' })
    );
    runGateReadable = false;
    const { events, err } = await snapshotOf('owner-own');
    expect(events).toEqual([]);
    expect((err as ProtocolError).code).toBe('unavailable');
  });

  it('a deleted record: a Delete for it alone; a new record: an Upsert', async () => {
    const run = await liveStream('owner-own');
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      {
        key: 'entry-2',
        recordId: OWNER_RECORD_2,
        version: 1,
        seq: 63,
        data: { t: OWNER_CANARY_2 },
      },
    ]);
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    expect(upserts(run.events)).toEqual([OWNER_URN, OWNER_URN_2]);
    run.stop();
    wake();
  });

  it('nothing changed: a poll sends nothing (POSITIVE CONTROL for the cases above)', async () => {
    const run = await liveStream('owner-grantee');
    const before = run.events.length;
    await poll(run);
    await poll(run);
    expect(run.events.length).toBe(before);
    run.stop();
    wake();
  });

  it('a failed read is not a revocation: the stream ends unavailable, with no Delete', async () => {
    const run = await liveStream('owner-grantee');
    dbMock.dbRead.appBlock.findUnique.mockRejectedValue(new Error('replica down'));
    await poll(run);
    expect(deletes(run.events)).toEqual([]);
    const err = await run.done;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('unavailable');
  });

  it('a resume after the grant was revoked sends the Delete first', async () => {
    const run = await liveStream('owner-grantee');
    const cursor = (run.events.find((e) => e.type === 'live') as { cursor: string }).cursor;
    run.stop();
    wake();
    await run.done;
    grantRow = null;
    const resumed = subscribe(
      composeAdapter(entities, publicFeed(), privateFeed()),
      await principalOf('owner-grantee'),
      cursor
    );
    await settle(resumed);
    expect(resumed.events.map((e) => e.type)).toEqual(['live', 'delete']);
    expect(deletes(resumed.events)).toEqual([OWNER_URN]);
    resumed.stop();
    wake();
  });
});

describe('🔴 private cursors', () => {
  /** The live cursor of an owner snapshot, and the adapter cursor inside it. */
  async function ownerCursor() {
    const feed = privateFeed();
    const adapter = composeAdapter(entities, publicFeed(), feed);
    const run = subscribe(adapter, await principalOf('owner-own'));
    await settle(run);
    run.stop();
    wake();
    await run.done;
    const bound = (run.events.find((e) => e.type === 'live') as { cursor: string }).cursor;
    const owner = await principalOf('owner-own');
    const raw = unbindCursor(bound, requestBinding({ schema: SCHEMA, urns: [] }, owner.subject));
    expect(raw).toMatch(/^p1\.[0-9a-f]{32}$/);
    return { adapter, raw };
  }
  /** A resume by `bearer` with `raw` re-bound to ITS subject (the binding is a public digest). */
  async function resumeAs(adapter: Adapter, bearer: string, raw: string) {
    const principal = await principalOf(bearer);
    const cursor = bindCursor(raw, requestBinding({ schema: SCHEMA, urns: [] }, principal.subject));
    const run = subscribe(adapter, principal, cursor);
    await settle(run);
    run.stop();
    wake();
    return { events: run.events, err: await run.done };
  }

  it("🔴 another subject re-binding the owner's cursor is cursor_expired, with no event", async () => {
    const { adapter, raw } = await ownerCursor();
    const { events, err } = await resumeAs(adapter, 'other-own', raw);
    expect(events).toEqual([]);
    expect((err as ProtocolError).code).toBe('cursor_expired');
    expect((err as ProtocolError).message).toBe('the cursor was issued to another token subject');
  });

  it('🔴 the same user through another client (another subject) is cursor_expired too', async () => {
    const { adapter, raw } = await ownerCursor();
    const { err } = await resumeAs(adapter, 'owner-grantee', raw);
    expect((err as ProtocolError).message).toBe('the cursor was issued to another token subject');
  });

  it("🔴 a token the gates refuse cannot resume a private cursor, even the owner's own subject", async () => {
    const { adapter, raw } = await ownerCursor();
    for (const bearer of ['owner-unlisted-relay', 'owner-no-appdataread']) {
      const { events, err } = await resumeAs(adapter, bearer, raw);
      expect(events).toEqual([]);
      expect((err as ProtocolError).message).toBe('this token cannot resume a private stream');
    }
  });

  it('valid for 7 days, then cursor_expired', async () => {
    const { adapter, raw } = await ownerCursor();
    now += PRIVATE_CURSOR_TTL_MS;
    expect((await resumeAs(adapter, 'owner-own', raw)).events.map((e) => e.type)).toEqual(['live']);
    now += 1;
    const late = await resumeAs(adapter, 'owner-own', raw);
    expect(late.events).toEqual([]);
    expect((late.err as ProtocolError).message).toBe(
      'the cursor is older than a private stream keeps'
    );
  });

  it('a private cursor never reaches the public feed, and with private streams off it expires', async () => {
    const { raw } = await ownerCursor();
    const { err } = await resumeAs(composeAdapter(entities, publicFeed()), 'owner-own', raw);
    expect((err as ProtocolError).code).toBe('cursor_expired');
    expect((err as ProtocolError).message).toBe('not a cursor this source issued');
  });
});

describe('🔴 a block-exchange token is held to its block token, on every poll', () => {
  /** The source app rated `rating` everywhere the feed reads it: the catalog and its DB row. */
  const rateSource = (rating: string) => {
    sourceRating = rating;
    rows[0].manifest = sourceManifest();
  };
  const deletes = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === 'delete' ? [e.urn] : []));
  /** A live stream, past its snapshot (which held the owner's record), parked in its first poll. */
  async function liveStream(bearer: string) {
    const run = subscribe(
      composeAdapter(entities, publicFeed(), privateFeed()),
      await principalOf(bearer)
    );
    await settle(run);
    expect(upserts(run.events)).toEqual([OWNER_URN]);
    return run;
  }
  async function poll(run: Run) {
    wake();
    await settle(run);
  }

  // The ceiling: `ratingAllowedForCeiling`, the document store's rule for a block token's import
  // (`doc-store-access.ts` `resolveImportAccess`): a mature rating only under a ceiling with a mature bit.
  it.each([
    ['its own app', 'owner-own-block-sfw', 'owner-own-block-xxx'],
    ['an import', 'owner-grantee-block-sfw', 'owner-grantee-block-xxx'],
  ])(
    '🔴 %s: an SFW-ceiling token streams no X-rated record; an XXX-ceiling token does',
    async (_label, sfw, xxx) => {
      rateSource('x');
      const narrow = await snapshotOf(sfw);
      expect(narrow.err).toBeUndefined();
      expect(narrow.events.map((e) => e.type)).toEqual(['live']);
      expect(JSON.stringify(narrow.events)).not.toContain(OWNER_CANARY);
      // POSITIVE CONTROL: the same user, client and settings, minted on the mature-capable host.
      const wide = await snapshotOf(xxx);
      expect(upserts(wide.events)).toEqual([OWNER_URN]);
      expect(JSON.stringify(wide.events)).toContain(OWNER_CANARY);
    }
  );

  it('an SFW-ceiling token still streams an SFW-rated (pg13) app: the ceiling holds back mature ratings only', async () => {
    const { events } = await snapshotOf('owner-own-block-sfw');
    expect(upserts(events)).toEqual([OWNER_URN]);
  });

  it('every mature rating (r, x, xxx) is held back under an SFW ceiling, and none is under XXX', async () => {
    for (const rating of ['r', 'x', 'xxx']) {
      rateSource(rating);
      expect(upserts((await snapshotOf('owner-own-block-sfw')).events), rating).toEqual([]);
      expect(upserts((await snapshotOf('owner-own-block-xxx')).events), rating).toEqual([
        OWNER_URN,
      ]);
    }
  });

  it("🔴 the token's block is no longer the client's approved one: the next poll sends a Delete", async () => {
    const run = await liveStream('owner-grantee-block-xxx');
    // The consumer's approved block switches: the token's block suspended, a successor approved.
    rows[1].status = 'suspended';
    rows.push({
      id: 'apb_con_next_7406',
      appId: CONSUMER_CLIENT,
      blockId: 'reader-app-next-2950',
      status: 'approved',
      manifest: consumerManifest(),
    });
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    run.stop();
    wake();
  });

  it('POSITIVE CONTROL: a user-exchange token for the same client is not cut by the switch', async () => {
    const run = await liveStream('owner-grantee-full');
    rows[1].status = 'suspended';
    rows.push({
      id: 'apb_con_next_7406',
      appId: CONSUMER_CLIENT,
      blockId: 'reader-app-next-2950',
      status: 'approved',
      manifest: consumerManifest(),
    });
    await poll(run);
    expect(deletes(run.events)).toEqual([]);
    run.stop();
    wake();
  });

  it("🔴 the token's install revoked (uninstalled, turned off): the next poll sends a Delete", async () => {
    const run = await liveStream('owner-own-block-xxx');
    // Read for the token's own install and user, and nothing else.
    expect(revocationReads.length).toBeGreaterThan(0);
    expect(new Set(revocationReads.map(([i, u]) => `${i}|${u}`))).toEqual(
      new Set([`${INSTALL_XXX}|${OWNER}`])
    );
    revokedInstalls.add(INSTALL_XXX);
    await poll(run);
    expect(deletes(run.events)).toEqual([OWNER_URN]);
    run.stop();
    wake();
  });

  it('another install revoked cuts nothing (POSITIVE CONTROL for the case above)', async () => {
    const run = await liveStream('owner-own-block-xxx');
    revokedInstalls.add(INSTALL_SFW);
    await poll(run);
    expect(deletes(run.events)).toEqual([]);
    run.stop();
    wake();
  });

  // INVARIANT GUARD (green before this change too): a token with no block binding reads as before.
  it('a user-exchange token is unchanged: the viewer’s settings alone, no install read', async () => {
    rateSource('x');
    const { events } = await snapshotOf('owner-full');
    expect(upserts(events)).toEqual([OWNER_URN]);
    expect(revocationReads).toEqual([]);
  });
});

describe('a private record carries its storage key (the shared app-data service matches by it)', () => {
  const upsertEntities = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === 'upsert' ? [e.entity] : []));

  it("the owner's snapshot: each record's key beside its body; the URN still names the record id", async () => {
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      { key: 'entry-1', recordId: OWNER_RECORD, version: 3, seq: 41, data: { t: OWNER_CANARY } },
      {
        key: 'entry-7c',
        recordId: OWNER_RECORD_2,
        version: 2,
        seq: 88,
        data: { t: OWNER_CANARY_2 },
      },
    ]);
    const { events } = await snapshotOf('owner-own');
    expect(
      upsertEntities(events)
        .map((e) => ({ urn: e.urn, key: e.key, body: e.body }))
        .sort((a, b) => (a.urn < b.urn ? -1 : 1))
    ).toEqual(
      [
        { urn: OWNER_URN, key: 'entry-1', body: { t: OWNER_CANARY } },
        { urn: OWNER_URN_2, key: 'entry-7c', body: { t: OWNER_CANARY_2 } },
      ].sort((a, b) => (a.urn < b.urn ? -1 : 1))
    );
  });

  it("🔴 another user's stream carries only their own key and record, never the owner's", async () => {
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      {
        key: 'owner-only-key-5d2',
        recordId: OWNER_RECORD,
        version: 3,
        seq: 41,
        data: { t: OWNER_CANARY },
      },
    ]);
    const { events } = await snapshotOf('other-own');
    expect(upsertEntities(events).map((e) => e.key)).toEqual(['entry-1']);
    expect(JSON.stringify(events)).not.toContain('owner-only-key-5d2');
    expect(JSON.stringify(events)).not.toContain(OWNER_CANARY);
  });

  it('🔴 a cursor saved before keys were carried resumes as a change: every record is sent again, with its key', async () => {
    const owner = await principalOf('owner-own');
    const binding = requestBinding({ schema: SCHEMA, urns: [] }, owner.subject);
    const adapter = composeAdapter(entities, publicFeed(), privateFeed());
    const first = subscribe(adapter, owner);
    await settle(first);
    first.stop();
    wake();
    await first.done;
    const schemas = upsertEntities(first.events)[0].schemas;
    const raw = unbindCursor(
      (first.events.find((e) => e.type === 'live') as { cursor: string }).cursor,
      binding
    );
    const digest = /^p1\.([0-9a-f]{32})$/.exec(raw ?? '')?.[1] as string;
    const resume = async () => {
      const run = subscribe(
        adapter,
        await principalOf('owner-own'),
        bindCursor(raw as string, binding)
      );
      await settle(run);
      run.stop();
      wake();
      await run.done;
      return run.events;
    };

    // Control: the cursor as this release saved it resumes with nothing to send.
    expect((await resume()).map((e) => e.type)).toEqual(['live']);

    // The same state as the release before keys saved it: the read digest and revs without the format.
    const state = JSON.parse((await store.get(digest)) as string) as {
      read: string;
      served: Array<[string, string]>;
    };
    state.read = sha256Hex(sortedKeyJson([[OWNER_RECORD, 3]])).slice(0, 32);
    state.served = [[OWNER_URN, docRev({ version: 3, data: { t: OWNER_CANARY } }, schemas)]];
    await store.put(digest, sortedKeyJson(state), `${SCHEMA}#x`);

    const events = await resume();
    expect(events.map((e) => e.type)).toEqual(['live', 'upsert']);
    expect(upsertEntities(events).map((e) => ({ urn: e.urn, key: e.key }))).toEqual([
      { urn: OWNER_URN, key: 'entry-1' },
    ]);
  });
});

describe('a private record carries its seq, and the stream its head (read-your-writes order)', () => {
  const upsertEntities = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === 'upsert' ? [e.entity] : []));
  /** Every `live` and `progress`, as its type and meta. */
  const positions = (events: StreamEvent[]) =>
    events.flatMap((e) =>
      e.type === 'live' || e.type === 'progress' ? [{ type: e.type, meta: e.meta }] : []
    );
  async function poll(run: Run) {
    wake();
    await settle(run);
  }

  it("each record carries its document's seq beside its key", async () => {
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      { key: 'entry-1', recordId: OWNER_RECORD, version: 3, seq: 41, data: { t: OWNER_CANARY } },
      {
        key: 'entry-7c',
        recordId: OWNER_RECORD_2,
        version: 2,
        seq: 88,
        data: { t: OWNER_CANARY_2 },
      },
    ]);
    const { events } = await snapshotOf('owner-own');
    expect(
      upsertEntities(events)
        .map((e) => ({ urn: e.urn, key: e.key, seq: e.seq }))
        .sort((a, b) => (a.urn < b.urn ? -1 : 1))
    ).toEqual(
      [
        { urn: OWNER_URN, key: 'entry-1', seq: 41 },
        { urn: OWNER_URN_2, key: 'entry-7c', seq: 88 },
      ].sort((a, b) => (a.urn < b.urn ? -1 : 1))
    );
  });

  it('live names the head its snapshot read; a poll whose head moved sends a progress with it, after its changes', async () => {
    const run = subscribe(
      composeAdapter(entities, publicFeed(), privateFeed()),
      await principalOf('owner-own')
    );
    await settle(run);
    expect(positions(run.events)).toEqual([{ type: 'live', meta: { head: { seq: 97 } } }]);

    // A write to the record: the next poll sends it, then the head it read.
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      { key: 'entry-1', recordId: OWNER_RECORD, version: 4, seq: 102, data: { t: OWNER_CANARY_2 } },
    ]);
    head = 102;
    const mark = run.events.length;
    await poll(run);
    const batch = run.events.slice(mark);
    expect(batch.map((e) => e.type)).toEqual(['upsert', 'progress']);
    expect(upsertEntities(batch).map((e) => e.seq)).toEqual([102]);
    expect(positions(batch)).toEqual([{ type: 'progress', meta: { head: { seq: 102 } } }]);
    // The progress closes the batch at the upsert's own position.
    expect((batch[1] as { cursor: string }).cursor).toBe((batch[0] as { cursor: string }).cursor);

    // A write to another collection of the app moves only the head: a progress, at the same cursor.
    head = 115;
    const quiet = run.events.length;
    await poll(run);
    expect(run.events.slice(quiet)).toEqual([
      {
        type: 'progress',
        cursor: (batch[1] as { cursor: string }).cursor,
        meta: { head: { seq: 115 } },
      },
    ]);
    // Nothing moved: nothing sent.
    const still = run.events.length;
    await poll(run);
    expect(run.events.length).toBe(still);
    run.stop();
    wake();
  });

  it('🔴 the head is read before the keyset: a write committing right after the keyset is not covered by it', async () => {
    const run = subscribe(
      composeAdapter(entities, publicFeed(), privateFeed()),
      await principalOf('owner-own')
    );
    await settle(run);
    // The next poll reads a changed keyset; a write (seq 131) commits just after its documents
    // read, so the poll did not see it.
    docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
      { key: 'entry-1', recordId: OWNER_RECORD, version: 4, seq: 124, data: { t: OWNER_CANARY_2 } },
    ]);
    head = 124;
    afterDocumentsRead = () => {
      docs.set(docsKey(SOURCE_ID, 'journal', OWNER), [
        { key: 'entry-1', recordId: OWNER_RECORD, version: 5, seq: 131, data: { t: OTHER_CANARY } },
      ]);
      head = 131;
    };
    reads = [];
    const before = run.events.length;
    await poll(run);
    // The poll's reads, in order: the head first.
    expect(reads).toEqual(['head', 'versions', 'documents']);
    const sent = run.events.slice(before);
    expect(upsertEntities(sent).map((e) => e.seq)).toEqual([124]);
    // The head it names is the one read before the keyset, never the later write's.
    expect(positions(sent)).toEqual([{ type: 'progress', meta: { head: { seq: 124 } } }]);
    // The next poll sees the write and names its head.
    const mark = run.events.length;
    await poll(run);
    expect(upsertEntities(run.events.slice(mark)).map((e) => e.seq)).toEqual([131]);
    expect(positions(run.events.slice(mark))).toEqual([
      { type: 'progress', meta: { head: { seq: 131 } } },
    ]);
    run.stop();
    wake();
  });

  // INVARIANT GUARD (green before this change too: nothing read a head then).
  it('a refused stream reads no head and names none', async () => {
    const { events } = await snapshotOf('other-grantee');
    expect(events).toEqual([{ type: 'live', cursor: expect.any(String) }]);
    expect(reads).not.toContain('head');
  });

  it('🔴 a cursor saved under k1 (keys, no seq) resumes as a change: every record is sent again with its seq, then the head', async () => {
    const owner = await principalOf('owner-own');
    const binding = requestBinding({ schema: SCHEMA, urns: [] }, owner.subject);
    const adapter = composeAdapter(entities, publicFeed(), privateFeed());
    const first = subscribe(adapter, owner);
    await settle(first);
    first.stop();
    wake();
    await first.done;
    const schemas = upsertEntities(first.events)[0].schemas;
    const raw = unbindCursor(
      (first.events.find((e) => e.type === 'live') as { cursor: string }).cursor,
      binding
    );
    const digest = /^p1\.([0-9a-f]{32})$/.exec(raw)?.[1] as string;
    const resume = async () => {
      const run = subscribe(adapter, await principalOf('owner-own'), bindCursor(raw, binding));
      await settle(run);
      run.stop();
      wake();
      await run.done;
      return run.events;
    };

    // Control: the cursor as this release saved it resumes with nothing to send but `live`.
    expect((await resume()).map((e) => e.type)).toEqual(['live']);

    // The same state as the k1 release saved it: its read digest and revs, and no head.
    const state = JSON.parse((await store.get(digest)) as string) as Record<string, unknown>;
    state.read = sha256Hex(sortedKeyJson({ f: 'k1', read: [[OWNER_RECORD, 3]] })).slice(0, 32);
    const k1Rev = sha256Hex(
      sortedKeyJson({
        f: 'k1',
        key: 'entry-1',
        rev: docRev({ version: 3, data: { t: OWNER_CANARY } }, schemas),
      })
    ).slice(0, 16);
    state.served = [[OWNER_URN, k1Rev]];
    delete state.head;
    await store.put(digest, sortedKeyJson(state), `${SCHEMA}#x`);

    const events = await resume();
    expect(events.map((e) => e.type)).toEqual(['live', 'upsert', 'progress']);
    expect(positions(events)).toEqual([
      { type: 'live', meta: undefined },
      { type: 'progress', meta: { head: { seq: 97 } } },
    ]);
    expect(upsertEntities(events).map((e) => ({ urn: e.urn, key: e.key, seq: e.seq }))).toEqual([
      { urn: OWNER_URN, key: 'entry-1', seq: 41 },
    ]);
  });
});
