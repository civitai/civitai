import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as DocStoreModule from '~/server/services/apps/doc-store';
import type { DocStoreDb } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  BOARD,
  ctx,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
} from '~/server/services/apps/__tests__/doc-store.functional';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { importersOf } from '~/server/services/apps/__tests__/import-ledger';

/**
 * The two server lookups that resolve an app-supplied shared item KEY to its author —
 * `readSharedItemForSubListing` (App Store sub-listings: author + hidden) and
 * `resolvePublishedContentAuthorUserId` (spend attribution: author) — against the REAL document
 * store on the embedded Postgres (real migration, least-privilege role), with the legacy per-app
 * `shared_kv` store faked at its pool. Run with row-level security OFF as well as on, so the
 * lookup's own app / namespace / scope predicates are what the isolation cases exercise.
 *
 * Every app's AppBlock id equals its blockId, so the legacy schema both versions of the code
 * derive is the same one: a legacy-fallback case reads the same row before and after the change.
 * User ids are pairwise distinct.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  lookup: undefined as unknown,
  legacy: new Map<string, { author: number; hidden: boolean }>(),
  legacyCalls: 0,
  appdataConfigured: false,
}));

// Whether the process has a document-store pool configured (`APPDATA_DATABASE_URL`).
vi.mock('~/server/db/appdataDb', () => ({
  get appdataDb() {
    return h.appdataConfigured ? {} : null;
  },
}));
vi.mock('~/server/services/apps/doc-store-lookup.instance', () => ({
  getDocStoreLookup: () => h.lookup,
}));
// The legacy per-app shared store: rows keyed by "<schema>/<key>".
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => ({
    query: async (sql: string, params: unknown[]) => {
      h.legacyCalls += 1;
      const schema = /FROM\s+("[a-z0-9_]+")\.shared_kv/.exec(sql)?.[1];
      const row = h.legacy.get(`${schema}/${String(params[0])}`);
      if (!row) return { rows: [] };
      return { rows: [{ author_user_id: row.author, hidden: row.hidden }] };
    },
  }),
}));

const { readSharedItemForSubListing, SubListingError } = await import(
  '~/server/services/blocks/app-sub-listing.service'
);
const { resolvePublishedContentAuthorUserId } = await import(
  '~/server/services/blocks/buzz-attribution.service'
);
const docStore = await vi.importActual<typeof DocStoreModule>('~/server/services/apps/doc-store');

const DOC_AUTHOR = 7301;
const LEGACY_AUTHOR = 7402;
const OTHER_AUTHOR = 7503;
const SPENDER = 7604;
const OWNER = 7705;
const MOD = 7806;

const MANIFEST = {
  storage: {
    collections: {
      posts: { visibility: 'shared', write: 'own' },
      board: { visibility: 'shared', write: 'own' },
      prefs: { visibility: 'private' },
      tallies: { visibility: 'shared', write: 'none', counters: ['plays'] },
    },
  },
};

/** A storage declaration the parser refuses. */
const BROKEN_MANIFEST = { storage: { collections: { posts: { visibility: 'bogus' } } } };
/** Storage declared, but no shared collection: the app's shared items are legacy. */
const LEGACY_ONLY_MANIFEST = { storage: { collections: { prefs: { visibility: 'private' } } } };
/**
 * The only shared collection is `write: "none"` (counters/marks only): it holds no item, so the
 * app has not moved and its shared items are legacy.
 */
const COUNTERS_ONLY_MANIFEST = {
  storage: {
    collections: { tallies: { visibility: 'shared', write: 'none', counters: ['plays'] } },
  },
};
const BOARD_ONLY_MANIFEST = {
  storage: { collections: { board: { visibility: 'shared', write: 'own' } } },
};

let appSeq = 0;
/** A fresh app per case: AppBlock id = blockId, so both code versions read the same schema. */
function freshApp(manifest: unknown = MANIFEST) {
  appSeq += 1;
  const id = `keys-app-${appSeq}`;
  apps.set(id, { blockId: id, manifest });
  return id;
}
const apps = new Map<string, { blockId: string; manifest: unknown }>();
const legacySchema = (appId: string) => `"app_${appId.replace(/-/g, '_')}"`;
function legacyRow(appId: string, key: string, author: number, hidden = false) {
  h.legacy.set(`${legacySchema(appId)}/${key}`, { author, hidden });
}

/** The fallback-on-a-refused-store log lines, by event name. */
const disabledLogs = () =>
  loggingMock.logToAxiom.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((e) => e?.name === 'app-shared-item-doc-store-disabled');

const subListing = (appId: string, key: string) => readSharedItemForSubListing(appId, key);
const attribution = (appId: string, key: string, spender = SPENDER) =>
  resolvePublishedContentAuthorUserId({
    appBlockId: appId,
    sharedContentKey: key,
    spenderUserId: spender,
    appOwnerUserId: OWNER,
  });

function defineSuite(rls: boolean) {
  describe(`row-level security ${rls ? 'ON' : 'OFF'}`, () => {
    let harness: Harness;
    let db: DocStoreDb;
    let store: DocStoreModule.DocStore;
    let mod: DocStoreModule.DocStoreModeration;

    beforeAll(async () => {
      harness = await createPgliteHarness({ rls });
      db = harness.db;
      store = docStore.createDocStore({ db });
      mod = docStore.createDocStoreModeration({ db });
    });
    afterAll(async () => {
      await harness?.close();
    });
    beforeEach(() => {
      // Looked up per call, so a version of the code without the lookup never builds one.
      h.lookup = docStore.createDocStoreLookup?.({ db });
      h.legacy.clear();
      h.legacyCalls = 0;
      h.appdataConfigured = false;
      loggingMock.logToAxiom.mockClear();
      dbMock.dbRead.appBlock.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) => apps.get(where.id) ?? null
      );
    });

    const put = (app: string, coll: DocCollection, key: string, uid: number, ns = NS_PROD) =>
      store.put(ctx(app, ns, uid), coll, key, { title: key });
    const hide = (app: string, coll: DocCollection, key: string) =>
      mod.setHidden(app, NS_PROD, coll.name, key, true, MOD);

    describe('readSharedItemForSubListing', () => {
      it('a document-store item resolves to its author', async () => {
        const app = freshApp();
        await put(app, POSTS, 'item-1', DOC_AUTHOR);
        expect(await subListing(app, 'item-1')).toEqual({
          authorUserId: DOC_AUTHOR,
          hidden: false,
        });
      });

      it('a hidden document-store item reads as hidden, as a hidden legacy row does', async () => {
        const app = freshApp();
        await put(app, BOARD, 'item-2', DOC_AUTHOR);
        await hide(app, BOARD, 'item-2');
        expect(await subListing(app, 'item-2')).toEqual({ authorUserId: DOC_AUTHOR, hidden: true });
      });

      it('a document-store hit decides alone: the legacy store is not read, even where its row differs', async () => {
        const app = freshApp();
        await put(app, POSTS, 'both', DOC_AUTHOR);
        legacyRow(app, 'both', LEGACY_AUTHOR, true);
        expect(await subListing(app, 'both')).toEqual({ authorUserId: DOC_AUTHOR, hidden: false });
        expect(h.legacyCalls).toBe(0);
      });

      it('after the move, an item deleted from the document store stays gone: its legacy copy is never read', async () => {
        const app = freshApp();
        await put(app, POSTS, 'moved', DOC_AUTHOR);
        legacyRow(app, 'moved', DOC_AUTHOR);
        await store.delete(ctx(app, NS_PROD, DOC_AUTHOR), POSTS, 'moved');
        expect(await subListing(app, 'moved')).toBeNull();
        expect(h.legacyCalls).toBe(0);
      });

      it('an app that declares no shared collection resolves from the legacy store, hidden state included (unchanged behaviour)', async () => {
        const app = freshApp(LEGACY_ONLY_MANIFEST);
        legacyRow(app, 'old-1', LEGACY_AUTHOR);
        legacyRow(app, 'old-2', LEGACY_AUTHOR, true);
        expect(await subListing(app, 'old-1')).toEqual({
          authorUserId: LEGACY_AUTHOR,
          hidden: false,
        });
        expect(await subListing(app, 'old-2')).toEqual({
          authorUserId: LEGACY_AUTHOR,
          hidden: true,
        });
      });

      it('in neither store: not found', async () => {
        const app = freshApp();
        expect(await subListing(app, 'nowhere')).toBeNull();
      });

      it('a key held by two shared collections is ambiguous: not found, and the legacy row is not used', async () => {
        const app = freshApp();
        await put(app, POSTS, 'twice', DOC_AUTHOR);
        await put(app, BOARD, 'twice', DOC_AUTHOR);
        legacyRow(app, 'twice', DOC_AUTHOR);
        expect(await subListing(app, 'twice')).toBeNull();
      });

      it("a dev namespace's document never resolves", async () => {
        const app = freshApp();
        await put(app, POSTS, 'dev-only', DOC_AUTHOR, `dev:${DOC_AUTHOR}`);
        expect(await subListing(app, 'dev-only')).toBeNull();
      });

      it("another app's document with the same key never resolves", async () => {
        const app = freshApp();
        const other = freshApp();
        await put(other, POSTS, 'shared-key', OTHER_AUTHOR);
        expect(await subListing(app, 'shared-key')).toBeNull();
        // Positive control: it does resolve for its own app.
        expect(await subListing(other, 'shared-key')).toEqual({
          authorUserId: OTHER_AUTHOR,
          hidden: false,
        });
      });

      it("a private collection's document with the key never resolves", async () => {
        const app = freshApp();
        await store.put(ctx(app, NS_PROD, DOC_AUTHOR), PREFS, 'mine', { title: 'x' });
        expect(await subListing(app, 'mine')).toBeNull();
      });

      it('a document in a write-"none" collection is not an item: not found', async () => {
        const app = freshApp();
        await store.increment(ctx(app, NS_PROD, DOC_AUTHOR), TALLIES, 'counted', 'plays', 1);
        expect(await subListing(app, 'counted')).toBeNull();
      });

      it("a counter kept under an item's own key does not make the key ambiguous", async () => {
        const app = freshApp();
        await put(app, POSTS, 'voted', DOC_AUTHOR);
        await store.increment(ctx(app, NS_PROD, OTHER_AUTHOR), TALLIES, 'voted', 'plays', 1);
        expect(await subListing(app, 'voted')).toEqual({ authorUserId: DOC_AUTHOR, hidden: false });
        expect(h.legacyCalls).toBe(0);
      });

      it('an app whose only shared collection is write-"none" still resolves from the legacy store', async () => {
        const app = freshApp(COUNTERS_ONLY_MANIFEST);
        legacyRow(app, 'old', LEGACY_AUTHOR);
        await store.increment(ctx(app, NS_PROD, DOC_AUTHOR), TALLIES, 'old', 'plays', 1);
        expect(await subListing(app, 'old')).toEqual({
          authorUserId: LEGACY_AUTHOR,
          hidden: false,
        });
        expect(h.legacyCalls).toBe(1);
      });

      it('a document-store read failure is a 503, and the legacy store is not read instead', async () => {
        const app = freshApp();
        legacyRow(app, 'k', LEGACY_AUTHOR);
        h.lookup = docStore.createDocStoreLookup?.({
          db: {
            connect: async () => {
              throw new Error('pool down');
            },
          },
        });
        const err = await subListing(app, 'k').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SubListingError);
        expect(err).toMatchObject({ status: 503, code: 'unavailable' });
        expect(h.legacyCalls).toBe(0);
      });

      it('no document store in this environment: the legacy store answers', async () => {
        const app = freshApp();
        legacyRow(app, 'k', LEGACY_AUTHOR);
        h.lookup = docStore.createDocStoreLookup?.({ db: null });
        expect(await subListing(app, 'k')).toEqual({ authorUserId: LEGACY_AUTHOR, hidden: false });
        expect(disabledLogs()).toEqual([]);
      });

      it('a configured document store that refuses its role falls back to legacy, and says so', async () => {
        const app = freshApp();
        legacyRow(app, 'k', LEGACY_AUTHOR);
        h.appdataConfigured = true;
        // The superuser connection bypasses RLS, so the store refuses every call.
        h.lookup = docStore.createDocStoreLookup?.({ db: harness.dbAs(null) });
        expect(await subListing(app, 'k')).toEqual({ authorUserId: LEGACY_AUTHOR, hidden: false });
        expect(disabledLogs()).toEqual([
          expect.objectContaining({ appBlockId: app, type: 'error' }),
        ]);
      });

      it('an approved manifest that does not parse is a 503, not a fall back to the legacy store', async () => {
        const app = freshApp(BROKEN_MANIFEST);
        legacyRow(app, 'k', LEGACY_AUTHOR);
        const err = await subListing(app, 'k').catch((e: unknown) => e);
        expect(err).toMatchObject({ status: 503, code: 'unavailable' });
        expect(h.legacyCalls).toBe(0);
      });

      it('a collection the approved manifest no longer declares is not read', async () => {
        const app = freshApp();
        await put(app, POSTS, 'undeclared', DOC_AUTHOR);
        apps.set(app, { blockId: app, manifest: BOARD_ONLY_MANIFEST });
        expect(await subListing(app, 'undeclared')).toBeNull();
      });
    });

    describe('resolvePublishedContentAuthorUserId', () => {
      it('a document-store item resolves to its author', async () => {
        const app = freshApp();
        await put(app, POSTS, 'gen-1', DOC_AUTHOR);
        expect(await attribution(app, 'gen-1')).toBe(DOC_AUTHOR);
      });

      it('a hidden document-store item attributes nobody, even with a visible legacy row', async () => {
        const app = freshApp();
        await put(app, POSTS, 'gen-2', DOC_AUTHOR);
        await hide(app, POSTS, 'gen-2');
        // A visible legacy copy of the same item: the document store's hide decides.
        legacyRow(app, 'gen-2', DOC_AUTHOR);
        expect(await attribution(app, 'gen-2')).toBeNull();
      });

      it('a document-store hit decides alone: the legacy store is not read, even where its row differs', async () => {
        const app = freshApp();
        await put(app, POSTS, 'both', DOC_AUTHOR);
        legacyRow(app, 'both', LEGACY_AUTHOR, true);
        expect(await attribution(app, 'both')).toBe(DOC_AUTHOR);
        expect(h.legacyCalls).toBe(0);
      });

      it('after the move, an item deleted from the document store attributes nobody: its legacy copy is never read', async () => {
        const app = freshApp();
        await put(app, POSTS, 'moved', DOC_AUTHOR);
        legacyRow(app, 'moved', DOC_AUTHOR);
        await store.delete(ctx(app, NS_PROD, DOC_AUTHOR), POSTS, 'moved');
        expect(await attribution(app, 'moved')).toBeNull();
        expect(h.legacyCalls).toBe(0);
      });

      it('an app that declares no shared collection resolves from the legacy store: visible attributes, hidden does not (unchanged behaviour)', async () => {
        const app = freshApp(LEGACY_ONLY_MANIFEST);
        legacyRow(app, 'old-1', LEGACY_AUTHOR);
        legacyRow(app, 'old-2', LEGACY_AUTHOR, true);
        expect(await attribution(app, 'old-1')).toBe(LEGACY_AUTHOR);
        expect(await attribution(app, 'old-2')).toBeNull();
      });

      it('in neither store: nobody', async () => {
        expect(await attribution(freshApp(), 'nowhere')).toBeNull();
      });

      it('the spender as author is still nobody (self-attribution)', async () => {
        const app = freshApp();
        await put(app, POSTS, 'self', SPENDER);
        expect(await attribution(app, 'self')).toBeNull();
        // Positive control: another spender of the same item attributes it.
        expect(await attribution(app, 'self', OTHER_AUTHOR)).toBe(SPENDER);
      });

      it('a key held by two shared collections is ambiguous: nobody, and the legacy row is not used', async () => {
        const app = freshApp();
        await put(app, POSTS, 'twice', DOC_AUTHOR);
        await put(app, BOARD, 'twice', OTHER_AUTHOR);
        legacyRow(app, 'twice', LEGACY_AUTHOR);
        expect(await attribution(app, 'twice')).toBeNull();
      });

      it("a dev namespace's document never resolves", async () => {
        const app = freshApp();
        await put(app, POSTS, 'dev-only', DOC_AUTHOR, `dev:${DOC_AUTHOR}`);
        expect(await attribution(app, 'dev-only')).toBeNull();
      });

      it("another app's document with the same key never resolves", async () => {
        const app = freshApp();
        const other = freshApp();
        await put(other, POSTS, 'shared-key', OTHER_AUTHOR);
        expect(await attribution(app, 'shared-key')).toBeNull();
        expect(await attribution(other, 'shared-key')).toBe(OTHER_AUTHOR);
      });

      it("a private collection's document with the key never resolves", async () => {
        const app = freshApp();
        await store.put(ctx(app, NS_PROD, DOC_AUTHOR), PREFS, 'mine', { title: 'x' });
        expect(await attribution(app, 'mine')).toBeNull();
      });

      it('a counter document attributes nobody: its first incrementer is not its author', async () => {
        const app = freshApp();
        await store.increment(ctx(app, NS_PROD, DOC_AUTHOR), TALLIES, 'counted', 'plays', 1);
        expect(await attribution(app, 'counted')).toBeNull();
      });

      it("a counter kept under an item's own key does not make the key ambiguous", async () => {
        const app = freshApp();
        await put(app, POSTS, 'voted', DOC_AUTHOR);
        await store.increment(ctx(app, NS_PROD, OTHER_AUTHOR), TALLIES, 'voted', 'plays', 1);
        expect(await attribution(app, 'voted')).toBe(DOC_AUTHOR);
      });

      it('an app whose only shared collection is write-"none" still attributes from the legacy store', async () => {
        const app = freshApp(COUNTERS_ONLY_MANIFEST);
        legacyRow(app, 'old', LEGACY_AUTHOR);
        expect(await attribution(app, 'old')).toBe(LEGACY_AUTHOR);
      });

      it('a document-store read failure attributes nobody and does not read the legacy store', async () => {
        const app = freshApp();
        legacyRow(app, 'k', LEGACY_AUTHOR);
        h.lookup = docStore.createDocStoreLookup?.({
          db: {
            connect: async () => {
              throw new Error('pool down');
            },
          },
        });
        expect(await attribution(app, 'k')).toBeNull();
        expect(h.legacyCalls).toBe(0);
      });

      it('no document store in this environment: the legacy store answers', async () => {
        const app = freshApp();
        legacyRow(app, 'k', LEGACY_AUTHOR);
        h.lookup = docStore.createDocStoreLookup?.({ db: null });
        expect(await attribution(app, 'k')).toBe(LEGACY_AUTHOR);
      });

      it('an approved manifest that does not parse attributes nobody and does not read the legacy store', async () => {
        const app = freshApp(BROKEN_MANIFEST);
        legacyRow(app, 'k', LEGACY_AUTHOR);
        expect(await attribution(app, 'k')).toBeNull();
        expect(h.legacyCalls).toBe(0);
      });
    });
  });
}

defineSuite(false);
defineSuite(true);

describe('the cross-collection lookup is reachable from the two key resolvers only', () => {
  // The lookup reads every shared collection of an app; the block-token routes' store must not
  // carry it. Pinned by parsing every import in src; fails when a set grows OR shrinks.
  it('only the shared-item resolver obtains the lookup, and only the two key resolvers call it', () => {
    expect(importersOf('server/services/apps/doc-store', 'createDocStoreLookup')).toEqual([
      'server/services/apps/doc-store-lookup.instance.ts',
    ]);
    expect(importersOf('server/services/apps/doc-store-lookup.instance')).toEqual([
      'server/services/apps/shared-item-key.ts',
    ]);
    expect(importersOf('server/services/apps/shared-item-key')).toEqual([
      'server/services/blocks/app-sub-listing.service.ts',
      'server/services/blocks/buzz-attribution.service.ts',
    ]);
  });

  it('the lookup object is the one read', () => {
    expect(Object.keys(docStore.createDocStoreLookup({ db: null }))).toEqual(['findSharedByKey']);
  });
});
