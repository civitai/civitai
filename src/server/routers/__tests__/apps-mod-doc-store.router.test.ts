import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreDb, DocStoreModeration } from '~/server/services/apps/doc-store';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';

/**
 * `apps.mod.docStore.*` end to end below the HTTP layer: the REAL router and its
 * `moderatorProcedure`, the REAL moderation service, and the REAL document store on the
 * embedded Postgres (real migration, least-privilege role, RLS on). Replaced at the
 * boundary only: the main-database rows (`AppBlock`, `User`, the audit table) through the
 * canonical db mock.
 *
 * Every effect is asserted through the store's own VIEWER reads — what an app would see —
 * never by reading back the moderation call's return value.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  mod: undefined as unknown as DocStoreModeration,
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/apps/doc-store-moderation.instance', () => ({
  getDocStoreModeration: () => h.mod,
}));
// The App Store card sync, recorded at its entry point (its effect on the card rows is covered
// in `app-sub-listing.service.test.ts`).
const cardSync = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  syncSubListingForSharedRow: vi.fn(async (args: unknown) => {
    cardSync.calls.push(args);
    if (cardSync.fail) throw new Error('store card sync unavailable');
  }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { appsModRouter } from '~/server/routers/apps-shared.router';
import { createDocStore, createDocStoreModeration } from '~/server/services/apps/doc-store';
import {
  MOD_APP_CONCURRENCY,
  MOD_QUEUE_MAX,
  MOD_QUEUE_PER_APP,
} from '~/server/services/apps/doc-store-moderation.service';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import { importersOf } from '~/server/services/apps/__tests__/import-ledger';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  BOARD,
  ctx as sctx,
  NS_PROD,
  POSTS,
  TALLIES,
  VIEWER_1,
  VIEWER_2,
} from '~/server/services/apps/__tests__/doc-store.functional';

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

// Pairwise-distinct app ids, in an order unlike their creation order.
const APP_A = {
  id: 'apb_MODA',
  blockId: 'mod-a',
  listing: { id: 'apl_moda', slug: 'mod-a-store' },
};
const APP_B = { id: 'apb_MODB', blockId: 'mod-b', listing: null };
const APP_C = { id: 'apb_MODC', blockId: 'mod-c', listing: { id: 'apl_modc', slug: 'mod-c' } };
const APPS = [APP_A, APP_B, APP_C];

const MOD = { id: 8801, isModerator: true, deletedAt: null, bannedAt: null };
const USER = { id: 8802, isModerator: false, deletedAt: null, bannedAt: null };
const R = [5101, 5202, 5303, 5404];

function ctx(user: unknown, cred: Record<string, unknown> = {}) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
    ...cred,
  };
}
const caller = (user: unknown = MOD, cred?: Record<string, unknown>) =>
  appsModRouter.createCaller(ctx(user, cred) as never).docStore;

let harness: Harness;
type AuditRow = { id: string; action: string; before: any; after?: any; [k: string]: unknown };
let audit: AuditRow[];

/**
 * PGlite is ONE session, and the queue runs several per-app transactions at once
 * (`MOD_APP_CONCURRENCY`), which on one session would interleave their `BEGIN`s. So
 * checkouts are serialised here, as a pool of size one would; a real pool gives each its
 * own connection.
 */
function serialised(db: DocStoreDb): DocStoreDb {
  let tail = Promise.resolve();
  return {
    async connect() {
      let unlock!: () => void;
      const prev = tail;
      tail = new Promise<void>((r) => (unlock = r));
      await prev;
      const c = await db.connect();
      return {
        query: (sql, params) => c.query(sql, params),
        release: (err) => {
          c.release(err);
          unlock();
        },
      };
    },
  };
}

beforeAll(async () => {
  // A real server when one is named (its pool connections really run in parallel), else PGlite.
  harness = REAL_PG_URL ? await createRealPgHarness() : await createPgliteHarness({ rls: true });
  const db = harness.concurrent ? harness.db : serialised(harness.db);
  h.store = createDocStore({ db });
  h.mod = createDocStoreModeration({ db });
});
afterAll(async () => {
  await harness?.close();
});

async function reset() {
  await harness.raw(
    `TRUNCATE appdata.doc, appdata.doc_index, appdata.doc_tally, appdata.doc_mark,
       appdata.doc_tomb, appdata.usage_app, appdata.usage_user`
  );
  audit = [];
}

// Spies on the store are restored even when the case that installed them fails.
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await reset();
  const toRow = (a: (typeof APPS)[number]) => ({
    id: a.id,
    blockId: a.blockId,
    appListing: a.listing,
  });
  mockRead.appBlock.findUnique.mockImplementation(async ({ where }: any) => {
    const a = APPS.find((x) => x.id === where.id);
    return a ? toRow(a) : null;
  });
  mockRead.appBlock.findMany.mockImplementation(async () => APPS.map(toRow));
  mockRead.user.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as number[]).map((id) => ({ id, username: `user${id}` }))
  );
  mockWrite.appListingModerationEvent.create.mockImplementation(async ({ data }: any) => {
    audit.push({ ...data });
    return data;
  });
  mockWrite.appListingModerationEvent.update.mockImplementation(async ({ where, data }: any) => {
    const row = audit.find((r) => r.id === where.id);
    if (row) Object.assign(row, data);
    return row;
  });
});

const v = (app: { id: string }, uid: number | null = VIEWER_1) => sctx(app.id, NS_PROD, uid);
async function report(app: { id: string }, coll: typeof POSTS, key: string, n: number) {
  for (const u of R.slice(0, n)) await h.store.mark(v(app, u), coll, key, 'report');
}

/**
 * A: posts/a1 ×3, posts/a0 ×3, board/a2 ×1.   B: posts/b1 ×2, posts/b2 ×1.   C: posts/c1 ×3.
 * Every document gets the same update time, so the order is reports, then app, collection
 * and key (all DESC):
 *   C/posts/c1:3, A/posts/a1:3, A/posts/a0:3, B/posts/b1:2, B/posts/b2:1, A/board/a2:1
 * (a1/a0 tie on count, time, app and collection: the per-app SQL orders them by key, and the
 * merge must keep that order.)
 */
async function seedQueue() {
  await h.store.put(v(APP_A), POSTS, 'a1', { status: 'open', score: 5 });
  await h.store.put(v(APP_A), POSTS, 'a0', { status: 'open' });
  await h.store.put(v(APP_A), BOARD, 'a2', { text: 'x' });
  await h.store.put(v(APP_B, VIEWER_2), POSTS, 'b1', { status: 'open' });
  await h.store.put(v(APP_B, VIEWER_2), POSTS, 'b2', { status: 'open' });
  await h.store.put(v(APP_C), POSTS, 'c1', { status: 'open' });
  await h.store.put(v(APP_C), POSTS, 'unreported', { status: 'open' });
  await report(APP_A, POSTS, 'a1', 3);
  await report(APP_A, POSTS, 'a0', 3);
  await report(APP_A, BOARD, 'a2', 1);
  await report(APP_B, POSTS, 'b1', 2);
  await report(APP_B, POSTS, 'b2', 1);
  await report(APP_C, POSTS, 'c1', 3);
  await harness.raw(`UPDATE appdata.doc SET updated_at = '2026-03-01T00:00:00Z'`);
}
const EXPECTED_ORDER = [
  'apb_MODC/posts/c1:3',
  'apb_MODA/posts/a1:3',
  'apb_MODA/posts/a0:3',
  'apb_MODB/posts/b1:2',
  'apb_MODB/posts/b2:1',
  'apb_MODA/board/a2:1',
];
const tag = (i: { appBlockId: string; collection: string; key: string; reports: number }) =>
  `${i.appBlockId}/${i.collection}/${i.key}:${i.reports}`;

describe('access: session moderators only', () => {
  const target = { appBlockId: APP_A.id, collection: 'posts', key: 'a1' };
  const calls = (c: ReturnType<typeof caller>) =>
    [
      ['listReported', () => c.listReported({})],
      ['get', () => c.get(target)],
      ['setHidden', () => c.setHidden({ ...target, hidden: true, reason: 'abuse report' })],
      ['delete', () => c.delete({ ...target, reason: 'abuse report' })],
    ] as const;

  async function expectRefusedAndUntouched(c: ReturnType<typeof caller>, code: string) {
    for (const [name, run] of calls(c)) {
      await expect(run(), name).rejects.toMatchObject({ code });
    }
    // Nothing was hidden, deleted or audited.
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
    expect(audit).toEqual([]);
  }

  it('a non-moderator session is FORBIDDEN on every procedure', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(caller(USER), 'FORBIDDEN');
  });

  it('no session (what a block token resolves to on tRPC: it is not an API key) is UNAUTHORIZED', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(caller(null), 'UNAUTHORIZED');
  });

  it('a moderator presenting a delegated (OAuth) token instead of a session is FORBIDDEN', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(
      caller(MOD, { apiKeyId: 77, apiKeyType: 'Access', subject: { type: 'oauth', id: 'cli_x' } }),
      'FORBIDDEN'
    );
  });

  it('positive control: the same calls succeed for a moderator session', async () => {
    await seedQueue();
    expect((await caller().listReported({})).items).toHaveLength(6);
    expect((await caller().get(target)).key).toBe('a1');
  });
});

/** A synthetic store row for the cap tests, which do not need real documents. */
function fakeRow(key: string, reports: number) {
  const at = new Date('2026-03-01T00:00:00Z');
  return {
    collection: 'posts',
    key,
    reports,
    createdAt: at,
    updatedAt: at,
    authorKind: 'user' as const,
    authorUid: VIEWER_1,
    hiddenAt: null,
    hiddenBy: null,
    sizeBytes: 10,
    version: 1,
    revision: 1,
  };
}

describe('listReported: the cross-app queue', () => {
  it('merges every app: most reports, then app/collection/key as tiebreaks; not truncated', async () => {
    await seedQueue();
    const out = await caller().listReported({});
    expect(out.items.map(tag)).toEqual(EXPECTED_ORDER);
    expect({ truncated: out.truncated, failedApps: out.failedApps }).toEqual({
      truncated: false,
      failedApps: 0,
    });
    const a1 = out.items.find((i) => i.key === 'a1')!;
    expect(a1).toMatchObject({
      appSlug: 'mod-a-store',
      author: { kind: 'user', userId: VIEWER_1, username: `user${VIEWER_1}` },
      hidden: null,
    });
    expect(out.items.find((i) => i.key === 'b1')!.appSlug).toBe('mod-b');
  });

  it('a more recent update outranks the app/collection/key tiebreak, across apps', async () => {
    await seedQueue();
    await harness.raw(
      `UPDATE appdata.doc SET updated_at = '2026-03-02T00:00:00Z' WHERE app_id = $1 AND key = 'a0'`,
      [APP_A.id]
    );
    expect((await caller().listReported({})).items.slice(0, 3).map(tag)).toEqual([
      'apb_MODA/posts/a0:3',
      'apb_MODC/posts/c1:3',
      'apb_MODA/posts/a1:3',
    ]);
  });

  it('asks the store once per app, for one row more than it keeps per app', async () => {
    await seedQueue();
    const spy = vi.spyOn(h.mod, 'listReported');
    await caller().listReported({ status: 'hidden' });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(APPS.map((a) => a.id).sort());
    expect(spy.mock.calls.map((c) => c[2])).toEqual(
      APPS.map(() => ({ status: 'hidden', limit: MOD_QUEUE_PER_APP + 1 }))
    );
  });

  it('truncated when one app has more than the per-app cap; exactly the cap is not', async () => {
    for (const [n, truncated] of [
      [MOD_QUEUE_PER_APP, false],
      [MOD_QUEUE_PER_APP + 1, true],
    ] as const) {
      vi.spyOn(h.mod, 'listReported').mockImplementation(async (appId) =>
        appId === APP_B.id
          ? Array.from({ length: n }, (_, i) => fakeRow(`k${String(i).padStart(3, '0')}`, 1))
          : []
      );
      const out = await caller().listReported({});
      expect({ n, kept: out.items.length, truncated: out.truncated }).toEqual({
        n,
        kept: MOD_QUEUE_PER_APP,
        truncated,
      });
      vi.restoreAllMocks();
    }
  });

  it('truncated when the apps together exceed the total cap, keeping the most reported', async () => {
    // Enough apps that each stays under the per-app cap while the sum exceeds the total cap,
    // so only the TOTAL cap can be what truncates.
    const apps = Math.ceil((MOD_QUEUE_MAX + 1) / MOD_QUEUE_PER_APP) + 1;
    const perApp = Math.ceil((MOD_QUEUE_MAX + 1) / apps);
    expect(perApp).toBeLessThan(MOD_QUEUE_PER_APP);
    mockRead.appBlock.findMany.mockImplementationOnce(async () =>
      Array.from({ length: apps }, (_, i) => ({
        id: `apb_TOT${i}`,
        blockId: `tot${i}`,
        appListing: null,
      }))
    );
    vi.spyOn(h.mod, 'listReported').mockImplementation(async () =>
      Array.from({ length: perApp }, (_, i) => fakeRow(`k${String(i).padStart(3, '0')}`, 1 + i))
    );
    const out = await caller().listReported({});
    expect(out.items).toHaveLength(MOD_QUEUE_MAX);
    expect(out.truncated).toBe(true);
    // Highest counts first, and every row cut was one with the lowest count (1).
    const cut = apps * perApp - MOD_QUEUE_MAX;
    expect(cut).toBeGreaterThan(0);
    expect(out.items[0].reports).toBe(perApp);
    expect(out.items.filter((i) => i.reports === 1)).toHaveLength(apps - cut);
  });

  it('an app whose read fails is skipped and counted; every other app is still listed', async () => {
    await seedQueue();
    const real = h.mod.listReported;
    vi.spyOn(h.mod, 'listReported').mockImplementation(async (appId, ...rest) => {
      if (appId === APP_B.id) throw new Error('storage is busy');
      return real(appId, ...rest);
    });
    const out = await caller().listReported({});
    expect(out.failedApps).toBe(1);
    expect(out.items.map(tag)).toEqual(EXPECTED_ORDER.filter((t) => !t.startsWith(APP_B.id)));
  });

  it('storage switched off is the storage error, never "N apps could not be read"', async () => {
    await seedQueue();
    const configured = h.mod;
    h.mod = createDocStoreModeration({ db: null });
    try {
      await expect(caller().listReported({})).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'document storage is not available',
      });
    } finally {
      h.mod = configured;
    }
  });

  it('an app id the store refuses as malformed fails that app only, never the queue', async () => {
    await seedQueue();
    mockRead.appBlock.findMany.mockImplementationOnce(async () => [
      ...APPS.map((a) => ({ id: a.id, blockId: a.blockId, appListing: a.listing })),
      { id: 'not a valid id!', blockId: 'odd', appListing: null },
    ]);
    const out = await caller().listReported({});
    expect({ failedApps: out.failedApps, items: out.items.map(tag) }).toEqual({
      failedApps: 1,
      items: EXPECTED_ORDER,
    });
  });

  it('keeps exactly MOD_APP_CONCURRENCY per-app store calls in flight, not more', async () => {
    // More apps than the limit, and store calls that overlap for as long as they are allowed
    // to, so an unbounded fan-out would reach the app count instead of the limit.
    const ids = Array.from({ length: MOD_APP_CONCURRENCY + 3 }, (_, i) => `apb_FAN${i}`);
    mockRead.appBlock.findMany.mockImplementationOnce(async () =>
      ids.map((id) => ({ id, blockId: id.toLowerCase(), appListing: null }))
    );
    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(h.mod, 'listReported').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return [];
    });
    await caller().listReported({});
    expect({ calls: spy.mock.calls.length, peak }).toEqual({
      calls: ids.length,
      peak: MOD_APP_CONCURRENCY,
    });
  });
});

describe('get', () => {
  it('returns the data and the author for a moderator; an unknown doc or app is NOT_FOUND', async () => {
    await seedQueue();
    const doc = await caller().get({ appBlockId: APP_A.id, collection: 'posts', key: 'a1' });
    expect(doc).toMatchObject({
      data: { status: 'open', score: 5 },
      reports: 3,
      author: { userId: VIEWER_1, username: `user${VIEWER_1}` },
      hidden: null,
    });
    await expect(
      caller().get({ appBlockId: APP_A.id, collection: 'posts', key: 'nope' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().get({ appBlockId: 'apb_NOPE', collection: 'posts', key: 'a1' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Not audited: a shared document is readable by every viewer of the app.
    expect(audit).toEqual([]);
  });
});

describe('setHidden / delete: effects through the app reads, and the audit trail', () => {
  const A1 = { appBlockId: APP_A.id, collection: 'posts', key: 'a1' };

  it('hide: the app reads not found; audited BEFORE the change with a snapshot and no content', async () => {
    await seedQueue();
    let visibleWhenAudited: boolean | null = null;
    mockWrite.appListingModerationEvent.create.mockImplementationOnce(async ({ data }: any) => {
      visibleWhenAudited = (await h.store.get(v(APP_A), POSTS, 'a1')) !== null;
      audit.push({ ...data });
      return data;
    });
    const out = await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    expect(out).toMatchObject({ changed: true, auditEventId: expect.stringMatching(/^alme_/) });
    expect(visibleWhenAudited).toBe(true);
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
    expect((await h.store.list(v(APP_A), POSTS)).items.map((d) => d.key)).toEqual(['a0']);

    expect(audit).toHaveLength(1);
    const [row] = audit;
    expect(row).toMatchObject({
      id: out.auditEventId,
      action: 'storage-doc-hide',
      actorUserId: MOD.id,
      reason: 'spam report',
      appListingId: 'apl_moda',
      slug: 'mod-a-store',
      before: {
        appBlockId: APP_A.id,
        ns: 'prod',
        collection: 'posts',
        key: 'a1',
        authorUserId: VIEWER_1,
        reports: 3,
        reportsTotal: 3,
        hiddenAt: null,
        version: 1,
        dataMd5: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
      after: { outcome: 'applied', changed: true },
    });
    // The content itself never enters the audit row.
    expect(JSON.stringify(row)).not.toContain('"open"');
    expect(APP_LISTING_MODERATION_ACTIONS as readonly string[]).toContain(row.action);

    // The queue still shows it, as hidden, to moderators.
    const hidden = await caller().listReported({ status: 'hidden' });
    expect(hidden.items.map((i) => [i.key, i.hidden?.byUserId, i.hidden?.byUsername])).toEqual([
      ['a1', MOD.id, `user${MOD.id}`],
    ]);
    expect((await caller().listReported({})).items.map((i) => i.key)).not.toContain('a1');
  });

  it('unhide restores it to the app and is audited as its own action', async () => {
    await seedQueue();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().setHidden({ ...A1, hidden: false, reason: 'reviewed, fine' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toMatchObject({ key: 'a1' });
    expect(audit.map((r) => r.action)).toEqual(['storage-doc-hide', 'storage-doc-unhide']);
    expect(audit[1].before.hiddenBy).toBe(MOD.id);
  });

  it('delete: gone for the app, usage refunded, audited', async () => {
    await seedQueue();
    const before = await h.store.usage(v(APP_A));
    const doc = await caller().get(A1);
    const out = await caller().delete({ ...A1, reason: 'illegal content' });
    expect(out).toMatchObject({ deleted: true, sizeBytes: doc.sizeBytes });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
    expect(await h.store.usage(v(APP_A))).toEqual({
      app: { bytes: before.app.bytes - doc.sizeBytes, docs: before.app.docs - 1 },
      viewer: { bytes: before.viewer!.bytes - doc.sizeBytes, docs: before.viewer!.docs - 1 },
    });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-delete', 'applied'],
    ]);
    await expect(caller().get(A1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('acting on app A leaves the other apps exactly as they were', async () => {
    await seedQueue();
    const others = async () =>
      Promise.all(
        [APP_B, APP_C].map(async (app) => ({
          list: (await h.store.list(v(app), POSTS)).items.map((d) => [d.key, d.version]),
          usage: await h.store.usage(v(app)),
        }))
      );
    const before = await others();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().delete({ ...A1, reason: 'illegal content' });
    await caller().delete({
      appBlockId: APP_A.id,
      collection: 'board',
      key: 'a2',
      reason: 'spam x',
    });
    expect(await others()).toEqual(before);
    // An app's key cannot be reached through another app's id.
    await expect(
      caller().delete({ appBlockId: APP_A.id, collection: 'posts', key: 'b1', reason: 'spam x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await h.store.get(v(APP_B, VIEWER_2), POSTS, 'b1')).not.toBeNull();
  });

  it('a missing document is NOT_FOUND before any audit row is written', async () => {
    await seedQueue();
    await expect(
      caller().setHidden({ ...A1, key: 'nope', hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().delete({ ...A1, key: 'nope', reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit).toEqual([]);
  });

  it('when the audit row cannot be written, nothing is hidden or deleted', async () => {
    await seedQueue();
    mockWrite.appListingModerationEvent.create.mockRejectedValue(
      Object.assign(new Error('violates check constraint "app_listing_mod_events_action_check"'), {
        code: 'P2010',
      })
    );
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toThrow();
    await expect(caller().delete({ ...A1, reason: 'spam report' })).rejects.toThrow();
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
  });

  it('an action carrying the revision the moderator saw is refused once the author edits', async () => {
    await seedQueue();
    const seen = await caller().get(A1);
    await h.store.put(v(APP_A), POSTS, 'a1', { status: 'edited', score: 1 });
    await expect(
      caller().delete({ ...A1, revision: seen.revision, reason: 'illegal content' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller().setHidden({ ...A1, hidden: true, revision: seen.revision, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toMatchObject({ version: 2 });
    expect(audit).toEqual([]);
    // The current revision goes through.
    const now = await caller().get(A1);
    await caller().delete({ ...A1, revision: now.revision, reason: 'illegal content' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
  });

  it('a stale row cannot delete a key its author deleted and re-created (version 1 again)', async () => {
    await seedQueue();
    const A2 = { appBlockId: APP_A.id, collection: 'board', key: 'a2' };
    const seen = await caller().get(A2);
    await h.store.delete(v(APP_A), BOARD, 'a2');
    await h.store.put(v(APP_A), BOARD, 'a2', { text: 'new, unreviewed' });
    await expect(
      caller().delete({ ...A2, revision: seen.revision, reason: 'illegal content' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await h.store.get(v(APP_A), BOARD, 'a2')).toMatchObject({
      version: 1,
      data: { text: 'new, unreviewed' },
    });
  });

  it('every store action is bound to the audited snapshot revision', async () => {
    await seedQueue();
    const hide = vi.spyOn(h.mod, 'setHidden');
    const del = vi.spyOn(h.mod, 'delete');
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().setHidden({ ...A1, hidden: false, reason: 'reviewed, fine' });
    await caller().delete({ ...A1, reason: 'illegal content' });
    expect(hide.mock.calls.map((c) => c[6])).toEqual([
      { ifRevision: audit[0].before.revision },
      { ifRevision: audit[1].before.revision },
    ]);
    expect(del.mock.calls.map((c) => c[4])).toEqual([{ ifRevision: audit[2].before.revision }]);
    // Unhide moved the revision, so each action carried its own snapshot's.
    expect(audit[2].before.revision).not.toBe(audit[0].before.revision);
  });

  it('an edit landing between the audit snapshot and the action: CONFLICT, stamped failed, nothing hidden', async () => {
    await seedQueue();
    const real = h.mod.setHidden;
    vi.spyOn(h.mod, 'setHidden').mockImplementationOnce(async (...args) => {
      await h.store.put(v(APP_A), POSTS, 'a1', { status: 'edited in the gap' });
      return real(...args);
    });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-hide', 'failed'],
    ]);
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toMatchObject({
      data: { status: 'edited in the gap' },
    });
  });

  it('a delete landing between the audit snapshot and the action: NOT_FOUND, stamped failed', async () => {
    await seedQueue();
    const real = h.mod.setHidden;
    vi.spyOn(h.mod, 'setHidden').mockImplementationOnce(async (...args) => {
      await h.store.delete(v(APP_A), POSTS, 'a1');
      return real(...args);
    });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit.map((r) => r.after?.outcome)).toEqual(['failed']);
  });

  it('a store refusal after the audit row is stamped failed; any other error unknown', async () => {
    await seedQueue();
    vi.spyOn(h.mod, 'setHidden')
      .mockRejectedValueOnce(new DocStoreError('rate_limited', 'storage is busy; retry'))
      .mockRejectedValueOnce(new Error('connection reset after commit'));
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-hide', 'failed'],
      ['storage-doc-hide', 'unknown'],
    ]);
  });

  it('dismiss: reviewed and kept — leaves the queue, stays visible to the app, audited', async () => {
    await seedQueue();
    await new Promise((r) => setTimeout(r, 5)); // past PGlite's millisecond clock tick
    const seen = await caller().get(A1);
    const out = await caller().dismissReports({
      ...A1,
      revision: seen.revision,
      reason: 'reviewed, within the rules',
    });
    expect(out).toMatchObject({ dismissed: 3, auditEventId: expect.stringMatching(/^alme_/) });
    expect((await caller().listReported({})).items.map((i) => i.key)).not.toContain('a1');
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
    expect(audit.map((r) => [r.action, r.before.reports, r.after?.outcome])).toEqual([
      ['storage-doc-dismiss', 3, 'applied'],
    ]);
    expect(APP_LISTING_MODERATION_ACTIONS as readonly string[]).toContain('storage-doc-dismiss');
    expect((await caller().get(A1)).reports).toBe(0);
  });

  it('dismiss is refused on a hidden document (unhide first); the refusal is audited as failed', async () => {
    await seedQueue();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await expect(
      caller().dismissReports({ ...A1, reason: 'reviewed, within the rules' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-hide', 'applied'],
      ['storage-doc-dismiss', 'failed'],
    ]);
    // Still hidden, its reports still open, and still listed for moderators.
    expect((await caller().get(A1)).reports).toBe(3);
    expect((await caller().listReported({ status: 'hidden' })).items.map((i) => i.key)).toEqual([
      'a1',
    ]);
  });

  it('dismissed, then hidden, then deleted: audits record 0 open of 3 reports; the hidden view still lists it', async () => {
    await seedQueue();
    await new Promise((r) => setTimeout(r, 5)); // past PGlite's millisecond clock tick
    await caller().dismissReports({ ...A1, reason: 'reviewed, within the rules' });
    await caller().setHidden({ ...A1, hidden: true, reason: 'second look: spam' });
    // Zero open reports, yet listed for moderators (and only there).
    expect(
      (await caller().listReported({ status: 'hidden' })).items.map((i) => [i.key, i.reports])
    ).toEqual([['a1', 0]]);
    expect((await caller().listReported({})).items.map((i) => i.key)).not.toContain('a1');
    await caller().delete({ ...A1, reason: 'illegal content' });
    expect(audit.map((r) => [r.action, r.before.reports, r.before.reportsTotal])).toEqual([
      ['storage-doc-dismiss', 3, 3],
      ['storage-doc-hide', 0, 3],
      ['storage-doc-delete', 0, 3],
    ]);
  });

  it('a reason is required and bounded', async () => {
    await seedQueue();
    await expect(caller().delete({ ...A1, reason: '  ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'x'.repeat(1001) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
  });
});

describe("the item's App Store card follows a moderator hide or delete, as for legacy shared rows", () => {
  const A1 = { appBlockId: APP_A.id, collection: 'posts', key: 'a1' };
  // Scoped to the document's author: the same key in another collection may be another item.
  const hidden = {
    appBlockId: APP_A.id,
    itemKey: 'a1',
    change: 'hidden',
    authorUserId: VIEWER_1,
    moderatorId: MOD.id,
  };
  beforeEach(() => {
    cardSync.calls = [];
    cardSync.fail = false;
  });

  it('hide hides the card; hiding an already-hidden document hides it again', async () => {
    await seedQueue();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    expect(cardSync.calls).toEqual([hidden, hidden]);
  });

  it('unhide leaves the card for a moderator to restore', async () => {
    await seedQueue();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().setHidden({ ...A1, hidden: false, reason: 'reviewed, fine' });
    expect(cardSync.calls).toEqual([hidden]);
  });

  it('delete hides the card', async () => {
    await seedQueue();
    await caller().delete({ ...A1, reason: 'illegal content' });
    expect(cardSync.calls).toEqual([hidden]);
  });

  it('a document no user authored backs no card: hiding or deleting it touches none', async () => {
    // A counter document's recorded uid is its first incrementer, not an author.
    await h.store.increment(v(APP_A), TALLIES, 'a1', 'plays', 1);
    const counter = { appBlockId: APP_A.id, collection: 'tallies', key: 'a1' };
    await caller().setHidden({ ...counter, hidden: true, reason: 'spam report' });
    await caller().delete({ ...counter, reason: 'illegal content' });
    expect(cardSync.calls).toEqual([]);
  });

  it('an action that did not happen touches no card', async () => {
    await seedQueue();
    await expect(
      caller().delete({ appBlockId: APP_A.id, collection: 'posts', key: 'b1', reason: 'spam x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(cardSync.calls).toEqual([]);
  });

  it('a failing card sync never fails the action', async () => {
    await seedQueue();
    cardSync.fail = true;
    await expect(caller().delete({ ...A1, reason: 'illegal content' })).resolves.toMatchObject({
      deleted: true,
    });
    expect(cardSync.calls).toEqual([hidden]);
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
  });
});

describe('the moderation operations are reachable from the moderator service only', () => {
  // Structural, not spelled: the operations live on a separate object, and the modules that can
  // obtain one are pinned by parsing every import in src (`import-ledger.ts`), failing when the
  // set grows OR shrinks.
  it('only the moderation service imports the moderation instance', () => {
    expect(importersOf('server/services/apps/doc-store-moderation.instance')).toEqual([
      'server/services/apps/doc-store-moderation.service.ts',
    ]);
  });

  it('only the moderation instance obtains the factory from the store module', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStoreModeration')).toEqual([
      'server/services/apps/doc-store-moderation.instance.ts',
    ]);
  });

  it('the viewer store the block-token routes hold carries no moderator operation', () => {
    const store = createDocStore({ db: null });
    expect(Object.keys(store).sort()).toEqual(
      [
        'create',
        'delete',
        'get',
        'getMany',
        'increment',
        'limits',
        'list',
        'mark',
        'unmark',
        'put',
        'usage',
      ].sort()
    );
  });
});
