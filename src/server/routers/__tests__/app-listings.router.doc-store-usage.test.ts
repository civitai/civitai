import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreDb } from '~/server/services/apps/doc-store';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

/**
 * `appListings.getMyDocStoreUsage` — an app owner's document-store usage against its limits —
 * end to end below the HTTP layer: the REAL router and its `appDeveloperProcedure`, the REAL
 * service, the REAL ownership resolver, and the REAL document store on the embedded Postgres
 * (real migration, least-privilege role, RLS on). Replaced at the boundary only: the
 * main-database rows (`AppBlock`, `AppCollaborator`, `AppListing`) through the canonical db
 * mock, and the author flag.
 *
 * Usage rows are seeded straight into `appdata.usage_app` with literal, pairwise-distinct
 * figures, so every expectation below is a number the test wrote, never one read back
 * through the code under test.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({ store: undefined as unknown as DocStore }));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  // `appDeveloperProcedure` gates on `getFeatureFlags(ctx).appBlocksAuthor`.
  getFeatureFlags: () => ({ appBlocksAuthor: true }),
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
import { appListingsRouter } from '~/server/routers/app-listings.router';
import { createDocStore } from '~/server/services/apps/doc-store';
import { resolveAccessibleAppBlockIds } from '~/server/services/blocks/app-access.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';

const mockRead = dbMock.dbRead;

const OWNER = 9101;
const OTHER_OWNER = 9202;
const EDITOR = 9303;
const STRANGER = 9404;

type Block = {
  id: string;
  blockId: string;
  ownerUserId: number;
  externalUrl: string | null;
  listing: { id: string; name: string } | null;
};
// Ids deliberately out of creation order, so the result's order is the service's own.
const APP_A: Block = {
  id: 'apb_USE_A',
  blockId: 'alpha-block',
  ownerUserId: OWNER,
  externalUrl: null,
  listing: { id: 'apl_use_a', name: 'Alpha' },
};
// No listing yet (a first version pending review): the block id is the only name it has.
const APP_B: Block = {
  id: 'apb_USE_B',
  blockId: 'beta-block',
  ownerUserId: OWNER,
  externalUrl: null,
  listing: null,
};
// Off-site: no document store at all, so never a row.
const APP_OFF: Block = {
  id: 'apb_USE_0',
  blockId: 'off-block',
  ownerUserId: OWNER,
  externalUrl: 'https://example.com/app',
  listing: { id: 'apl_use_off', name: 'Offsite' },
};
const APP_X: Block = {
  id: 'apb_USE_X',
  blockId: 'xray-block',
  ownerUserId: OTHER_OWNER,
  externalUrl: null,
  listing: { id: 'apl_use_x', name: 'Xray' },
};
const BLOCKS = [APP_X, APP_B, APP_OFF, APP_A];

function ctx(user: unknown) {
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
const usageOf = (u: unknown) =>
  appListingsRouter.createCaller(ctx(u) as never).getMyDocStoreUsage();

/** One PGlite session: serialise checkouts, as a pool of one would (see the mod queue suite). */
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

let harness: Harness;
let liveStore: DocStore;

beforeAll(async () => {
  harness = REAL_PG_URL ? await createRealPgHarness() : await createPgliteHarness({ rls: true });
  liveStore = createDocStore({ db: harness.concurrent ? harness.db : serialised(harness.db) });
});
afterAll(async () => {
  await harness?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUsage(appId: string, ns: string, bytes: number, docs: number) {
  await harness.raw(
    `INSERT INTO appdata.usage_app (app_id, ns, bytes, docs, last_seq) VALUES ($1, $2, $3, $4, 1)`,
    [appId, ns, bytes, docs]
  );
}

beforeEach(async () => {
  h.store = liveStore;
  await harness.raw(`TRUNCATE appdata.usage_app, appdata.usage_user`);
  // Production usage, pairwise distinct across apps and figures.
  await seedUsage(APP_A.id, 'prod', 3_145_728, 4_321);
  await seedUsage(APP_X.id, 'prod', 7_777_777, 888);
  // Developer and review namespaces of the SAME apps: never part of the production figure.
  await seedUsage(APP_A.id, `dev:${OWNER}`, 999_999, 77);
  await seedUsage(APP_A.id, 'rev:apr_1:42', 123_456, 9);
  await seedUsage(APP_B.id, `dev:${OWNER}`, 5_555, 5);

  // The main-database reads, answered from BLOCKS by the shape each query actually asks.
  mockRead.appBlock.findMany.mockImplementation(async ({ where, select }: any) => {
    let rows = BLOCKS.slice();
    if (where?.app?.userId !== undefined) {
      rows = rows.filter((b) => b.ownerUserId === where.app.userId);
    }
    if (where?.id?.in) rows = rows.filter((b) => (where.id.in as string[]).includes(b.id));
    if (where && 'externalUrl' in where && where.externalUrl === null) {
      rows = rows.filter((b) => b.externalUrl === null);
    }
    return rows.map((b) => ({
      id: b.id,
      ...(select?.blockId ? { blockId: b.blockId } : {}),
      ...(select?.appListing ? { appListing: b.listing ? { name: b.listing.name } : null } : {}),
    }));
  });
  // EDITOR holds an ACCEPTED seat on the owner's app A.
  mockRead.appCollaborator.findMany.mockImplementation(async ({ where }: any) =>
    where?.userId === EDITOR && where?.status === 'accepted'
      ? [{ appListingId: APP_A.listing!.id }]
      : []
  );
  mockRead.appListing.findMany.mockImplementation(async ({ where }: any) =>
    BLOCKS.filter((b) => b.listing && (where?.id?.in ?? []).includes(b.listing.id)).map((b) => ({
      appBlockId: b.id,
    }))
  );
});

const LIMITS = { appBytes: 52_428_800, appDocs: 1_000_000 };

describe('appListings.getMyDocStoreUsage', () => {
  it("the owner sees each of their on-platform apps' PRODUCTION usage against the per-app limits", async () => {
    expect(await usageOf(user(OWNER))).toEqual({
      status: 'ok',
      limits: LIMITS,
      apps: [
        { appBlockId: APP_A.id, name: 'Alpha', usage: { bytes: 3_145_728, docs: 4_321 } },
        // No production row is a real zero (the store's own reading of a missing row).
        { appBlockId: APP_B.id, name: 'beta-block', usage: { bytes: 0, docs: 0 } },
      ],
    });
  });

  it("another owner sees only their own app, never the first owner's", async () => {
    expect(await usageOf(user(OTHER_OWNER))).toEqual({
      status: 'ok',
      limits: LIMITS,
      apps: [{ appBlockId: APP_X.id, name: 'Xray', usage: { bytes: 7_777_777, docs: 888 } }],
    });
  });

  it('a user who owns nothing gets nothing', async () => {
    expect(await usageOf(user(STRANGER))).toEqual({ status: 'ok', limits: LIMITS, apps: [] });
  });

  it("an accepted collaborator is NOT an owner: the seat does not reach the owner's usage", async () => {
    // Positive control: the fixture really does seat EDITOR on app A, so the empty result
    // below is the ownership decision, not a seat the mock never produced.
    expect((await resolveAccessibleAppBlockIds(EDITOR)).editorIds).toEqual([APP_A.id]);
    expect(await usageOf(user(EDITOR))).toEqual({ status: 'ok', limits: LIMITS, apps: [] });
  });

  it('an anonymous caller is refused', async () => {
    await expect(usageOf(undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a disabled store reads as unavailable, never as zero usage', async () => {
    h.store = createDocStore({ db: null });
    expect(await usageOf(user(OWNER))).toEqual({ status: 'disabled' });
  });

  it('one app whose read fails is unknown (null), and the other apps still show', async () => {
    const real = liveStore.usage.bind(liveStore);
    vi.spyOn(liveStore, 'usage').mockImplementation(async (c) => {
      if (c.appId === APP_B.id) throw new Error('connection reset');
      return real(c);
    });
    expect(await usageOf(user(OWNER))).toEqual({
      status: 'ok',
      limits: LIMITS,
      apps: [
        { appBlockId: APP_A.id, name: 'Alpha', usage: { bytes: 3_145_728, docs: 4_321 } },
        { appBlockId: APP_B.id, name: 'beta-block', usage: null },
      ],
    });
  });
});
