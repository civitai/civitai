import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocStore,
  DocStoreViewerData,
  ViewerDataEmptyResult,
} from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';

/**
 * `appStorage.*` — a signed-in user's own document-store data across apps — end to end below the
 * HTTP layer: the REAL router, the REAL service, and the REAL document store on the embedded
 * Postgres (real migration, least-privilege role), run with row-level security ON and OFF (OFF
 * leaves the module's own predicates as the only thing keeping another viewer's or another
 * app's rows out). Replaced at the boundary only: the `AppBlock` names through the canonical db
 * mock, the App Blocks flag, and the rate limiter.
 *
 * Every document is written through the store with a payload of known size, so each expected
 * figure is a literal: `{"t": "<n chars>"}` is n + 9 bytes of canonical JSON text. The ceilings
 * are custom and distinct from the defaults, so a figure that leaked a constant would show.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  viewerData: undefined as unknown as DocStoreViewerData,
  appBlocksEnabled: true,
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/apps/doc-store-viewer-data.instance', () => ({
  getDocStoreViewerData: () => h.viewerData,
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: vi.fn(async () => h.appBlocksEnabled),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: () => false,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { appStorageRouter } from '~/server/routers/app-storage.router';
import { createDocStore, createDocStoreViewerData } from '~/server/services/apps/doc-store';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  assertUsageConsistent,
  BOARD,
  ctx as storeCtx,
  decl,
  POSTS,
  PREFS,
  snapshot,
} from '~/server/services/apps/__tests__/doc-store.functional';

// Pairwise distinct, and distinct from every figure below.
const USER = 8_101;
const OTHER = 8_202;
const NOBODY = 8_303;

const LIMITS = { appBytes: 900_001, appDocs: 9_001, userBytes: 7_003, userDocs: 17 };

const APP_A = { id: 'apb_STO_A', blockId: 'alpha-store', listing: 'Alpha Notes' };
// No listing yet: the block id is the only name it has.
const APP_B = { id: 'apb_STO_B', blockId: 'beta-store', listing: null };
// Its AppBlock row is gone; the data is still the user's to see and empty.
const APP_GONE = 'apb_STO_Z';
const BLOCKS = [APP_B, APP_A];

const NOTES: DocCollection = { name: 'notes', config: decl({ visibility: 'private' }) };

/** A payload whose stored size is exactly `bytes`. */
const sized = (bytes: number) => ({ t: 'x'.repeat(bytes - 9) });

function trpcCtx(user: unknown) {
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
  };
}
const user = (id: number) => ({
  id,
  isModerator: false,
  tier: 'free',
  username: `u${id}`,
  onboarding: 0x1f,
});
const caller = (u: unknown) => appStorageRouter.createCaller(trpcCtx(u) as never);

function defineAppStorageSuite(makeHarness: () => Promise<Harness>) {
  let harness: Harness;

  beforeAll(async () => {
    harness = await makeHarness();
  });
  afterAll(async () => {
    await harness?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    h.appBlocksEnabled = true;
    h.store = createDocStore({ db: harness.db, limits: LIMITS });
    h.viewerData = createDocStoreViewerData({ db: harness.db, limits: LIMITS });
    await harness.raw(
      `TRUNCATE appdata.doc, appdata.doc_index, appdata.doc_tally, appdata.doc_mark,
                appdata.doc_tomb, appdata.usage_app, appdata.usage_user`
    );
    dbMock.dbRead.appBlock.findMany.mockImplementation(async ({ where }: any) =>
      BLOCKS.filter((b) => (where?.id?.in as string[]).includes(b.id)).map((b) => ({
        id: b.id,
        blockId: b.blockId,
        appListing: b.listing ? { name: b.listing } : null,
      }))
    );

    const s = h.store;
    const uA = storeCtx(APP_A.id, 'prod', USER);
    const oA = storeCtx(APP_A.id, 'prod', OTHER);
    // USER in A: two private documents and one shared post (121 + 233 + 57 = 411 bytes).
    await s.put(uA, PREFS, 'theme', sized(121));
    await s.put(uA, NOTES, 'n1', sized(233));
    await s.put(uA, POSTS, 'post-u', sized(57));
    // OTHER in A: a private document and a shared post; each marks the other's post.
    await s.put(oA, PREFS, 'theme', sized(86));
    await s.put(oA, POSTS, 'post-o', sized(39));
    await s.mark(oA, POSTS, 'post-u', 'vote');
    await s.mark(uA, POSTS, 'post-o', 'vote');
    // USER elsewhere: another app, a removed app, and their own dev namespace of app A.
    await s.put(storeCtx(APP_B.id, 'prod', USER), PREFS, 'theme', sized(309));
    await s.put(storeCtx(APP_GONE, 'prod', USER), PREFS, 'theme', sized(73));
    await s.put(storeCtx(APP_A.id, `dev:${USER}`, USER), PREFS, 'theme', sized(509));
  });

  /** USER's own rows in (app, ns): documents by key space and the usage row. */
  async function userRows(appId: string, ns: string, uid: number) {
    return {
      privateKeys: (
        await harness.raw(
          `SELECT coll, key FROM appdata.doc WHERE app_id = $1 AND ns = $2 AND scope_uid = $3
            ORDER BY coll, key`,
          [appId, ns, uid]
        )
      ).map((r) => `${r.coll}/${r.key}`),
      sharedKeys: (
        await harness.raw(
          `SELECT coll, key FROM appdata.doc WHERE app_id = $1 AND ns = $2 AND scope_uid = 0
             AND author_kind = 'user' AND author_uid = $3 ORDER BY coll, key`,
          [appId, ns, uid]
        )
      ).map((r) => `${r.coll}/${r.key}`),
      usage: (
        await harness.raw(
          `SELECT bytes::int AS bytes, docs FROM appdata.usage_user
            WHERE app_id = $1 AND ns = $2 AND user_id = $3`,
          [appId, ns, uid]
        )
      )[0],
    };
  }

  describe('listMine', () => {
    it("lists every app the user holds production data in, by name, with the user's own usage against the per-viewer ceiling", async () => {
      expect(await caller(user(USER)).listMine()).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        apps: [
          // Private and authored shared documents both count; OTHER's do not; dev does not.
          {
            appBlockId: APP_A.id,
            name: 'Alpha Notes',
            slug: 'alpha-store',
            usage: { bytes: 411, docs: 3 },
          },
          {
            appBlockId: APP_B.id,
            name: 'beta-store',
            slug: 'beta-store',
            usage: { bytes: 309, docs: 1 },
          },
          { appBlockId: APP_GONE, name: null, slug: null, usage: { bytes: 73, docs: 1 } },
        ],
      });
    });

    it("another user sees only their own figure in the app they share, never the first user's apps", async () => {
      expect(await caller(user(OTHER)).listMine()).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        apps: [
          {
            appBlockId: APP_A.id,
            name: 'Alpha Notes',
            slug: 'alpha-store',
            usage: { bytes: 125, docs: 2 },
          },
        ],
      });
    });

    it('a user with no data gets an empty list', async () => {
      expect(await caller(user(NOBODY)).listMine()).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        apps: [],
      });
    });

    it('a disabled store reads as unavailable, never as no data', async () => {
      h.viewerData = createDocStoreViewerData({ db: null });
      expect(await caller(user(USER)).listMine()).toEqual({ status: 'disabled' });
    });
  });

  describe('getMineForApp', () => {
    it("is the user's usage in that one app's production namespace", async () => {
      expect(await caller(user(USER)).getMineForApp({ appBlockId: APP_A.id })).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        usage: { bytes: 411, docs: 3 },
      });
      // An app the user never wrote to is a real zero (the store's reading of a missing row).
      expect(await caller(user(NOBODY)).getMineForApp({ appBlockId: APP_A.id })).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        usage: { bytes: 0, docs: 0 },
      });
    });
  });

  describe('emptyMine', () => {
    it("deletes only the user's PRIVATE documents in that app's production namespace, refunds their usage and tombstones them; their shared post, other apps, their dev namespace and the other user are untouched", async () => {
      const before = {
        b: await snapshot(harness, APP_B.id),
        gone: await snapshot(harness, APP_GONE),
        other: await userRows(APP_A.id, 'prod', OTHER),
        dev: await userRows(APP_A.id, `dev:${USER}`, USER),
      };
      // Positive controls: the rows the assertions below say are gone or kept do exist.
      expect(await userRows(APP_A.id, 'prod', USER)).toEqual({
        privateKeys: ['notes/n1', 'prefs/theme'],
        sharedKeys: ['posts/post-u'],
        usage: { bytes: 411, docs: 3 },
      });
      expect(before.other.privateKeys).toEqual(['prefs/theme']);
      expect(before.dev.privateKeys).toEqual(['prefs/theme']);

      const out: ViewerDataEmptyResult = await caller(user(USER)).emptyMine({
        appBlockId: APP_A.id,
      });
      expect(out).toEqual({ privateDocs: 2, privateBytes: 354, sharedDocs: 0, sharedBytes: 0 });

      expect(await userRows(APP_A.id, 'prod', USER)).toEqual({
        privateKeys: [],
        sharedKeys: ['posts/post-u'],
        usage: { bytes: 57, docs: 1 },
      });
      expect(
        await harness.raw(
          `SELECT coll, key FROM appdata.doc_tomb WHERE app_id = $1 AND ns = 'prod'
             AND scope_uid = $2 ORDER BY coll, key`,
          [APP_A.id, USER]
        )
      ).toEqual([
        { coll: 'notes', key: 'n1' },
        { coll: 'prefs', key: 'theme' },
      ]);
      expect(await userRows(APP_A.id, 'prod', OTHER)).toEqual(before.other);
      expect(await userRows(APP_A.id, `dev:${USER}`, USER)).toEqual(before.dev);
      expect(await snapshot(harness, APP_B.id)).toEqual(before.b);
      expect(await snapshot(harness, APP_GONE)).toEqual(before.gone);
      await assertUsageConsistent(harness, APP_A.id, 'prod');
      expect(harness.violations).toEqual([]);

      // The listing reads the refunded figure.
      const listed = await caller(user(USER)).listMine();
      expect(listed.status === 'ok' && listed.apps[0]).toEqual({
        appBlockId: APP_A.id,
        name: 'Alpha Notes',
        slug: 'alpha-store',
        usage: { bytes: 57, docs: 1 },
      });
    });

    it('is idempotent: a second run deletes nothing and writes nothing', async () => {
      await caller(user(USER)).emptyMine({ appBlockId: APP_A.id });
      const after = await snapshot(harness, APP_A.id);
      expect(await caller(user(USER)).emptyMine({ appBlockId: APP_A.id })).toEqual({
        privateDocs: 0,
        privateBytes: 0,
        sharedDocs: 0,
        sharedBytes: 0,
      });
      expect(await snapshot(harness, APP_A.id)).toEqual(after);
    });

    it("with includeShared, also deletes the user's VISIBLE shared posts as an author delete does (marks, app refund, tombstone), leaves a hidden one for moderation, and leaves the other user's post and the user's mark on it", async () => {
      const uA = storeCtx(APP_A.id, 'prod', USER);
      await h.store.put(uA, BOARD, 'note-hidden', sized(29));
      await harness.raw(
        `UPDATE appdata.doc SET hidden_at = now(), hidden_by = 1
          WHERE app_id = $1 AND ns = 'prod' AND coll = 'board' AND key = 'note-hidden'`,
        [APP_A.id]
      );
      const appUsage = async () =>
        (
          await harness.raw(
            `SELECT bytes::int AS bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
            [APP_A.id]
          )
        )[0];
      const votes = async (key: string) =>
        (
          await harness.raw(
            `SELECT user_id FROM appdata.doc_mark WHERE app_id = $1 AND ns = 'prod' AND key = $2
              ORDER BY user_id`,
            [APP_A.id, key]
          )
        ).map((r) => r.user_id);
      // Shared bytes: 57 + 39 + 29.
      expect(await appUsage()).toEqual({ bytes: 125, docs: 3 });
      expect(await votes('post-u')).toEqual([OTHER]);
      const otherBefore = await userRows(APP_A.id, 'prod', OTHER);

      expect(
        await caller(user(USER)).emptyMine({ appBlockId: APP_A.id, includeShared: true })
      ).toEqual({ privateDocs: 2, privateBytes: 354, sharedDocs: 1, sharedBytes: 57 });

      expect(await userRows(APP_A.id, 'prod', USER)).toEqual({
        privateKeys: [],
        sharedKeys: ['board/note-hidden'],
        usage: { bytes: 29, docs: 1 },
      });
      expect(await appUsage()).toEqual({ bytes: 68, docs: 2 });
      expect(await votes('post-u')).toEqual([]);
      expect(await votes('post-o')).toEqual([USER]);
      expect(await userRows(APP_A.id, 'prod', OTHER)).toEqual(otherBefore);
      expect(
        await harness.raw(
          `SELECT coll, key FROM appdata.doc_tomb WHERE app_id = $1 AND ns = 'prod' AND scope_uid = 0`,
          [APP_A.id]
        )
      ).toEqual([{ coll: 'posts', key: 'post-u' }]);
      await assertUsageConsistent(harness, APP_A.id, 'prod');
      expect(harness.violations).toEqual([]);
    });

    it("acts on the caller only: another user emptying the same app, shared posts included, leaves this user's documents", async () => {
      await caller(user(OTHER)).emptyMine({ appBlockId: APP_A.id, includeShared: true });
      expect((await userRows(APP_A.id, 'prod', USER)).sharedKeys).toEqual(['posts/post-u']);
      expect((await userRows(APP_A.id, 'prod', USER)).privateKeys).toEqual([
        'notes/n1',
        'prefs/theme',
      ]);
      // Refunded to zero (the row stays, as an author delete leaves it), so the app drops out
      // of OTHER's list.
      expect(await userRows(APP_A.id, 'prod', OTHER)).toEqual({
        privateKeys: [],
        sharedKeys: [],
        usage: { bytes: 0, docs: 0 },
      });
      expect(await caller(user(OTHER)).listMine()).toEqual({
        status: 'ok',
        limits: { userBytes: 7_003, userDocs: 17 },
        apps: [],
      });
    });
  });

  describe('access', () => {
    it('an anonymous caller is refused', async () => {
      await expect(caller(undefined).listMine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(caller(undefined).emptyMine({ appBlockId: APP_A.id })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('is refused with App Blocks off, and deletes nothing', async () => {
      h.appBlocksEnabled = false;
      await expect(caller(user(USER)).listMine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(caller(user(USER)).emptyMine({ appBlockId: APP_A.id })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect((await userRows(APP_A.id, 'prod', USER)).privateKeys).toEqual([
        'notes/n1',
        'prefs/theme',
      ]);
    });

    it('a malformed app id is a bad request, not a store fault', async () => {
      await expect(
        caller(user(USER)).emptyMine({ appBlockId: "apb_A' OR 1=1" })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
}

describe('appStorage router on PGlite — appdata_rw, RLS on: both layers', () => {
  defineAppStorageSuite(() => createPgliteHarness({ rls: true }));
});

describe('appStorage router on PGlite — appdata_rw, RLS disabled: the module predicates alone', () => {
  defineAppStorageSuite(() => createPgliteHarness({ rls: false }));
});

describe.skipIf(!REAL_PG_URL)('appStorage router on a real Postgres', () => {
  defineAppStorageSuite(createRealPgHarness);
});
