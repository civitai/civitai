import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserStoragePurge from '~/server/services/apps/user-storage-purge.service';
import type { DocStoreDb, DocStoreMaintenance } from '~/server/services/apps/doc-store';

/**
 * `removeAllContent` → the App Blocks DOCUMENT STORE half of an account wipe.
 *
 * 🔴 THE STORE IS NOT MOCKED. The maintenance object the wipe obtains is a real one over an
 * embedded Postgres (RLS on, `appdata_rw`) holding rows for the wiped account and a bystander,
 * and the assertions are on those rows — so a wipe wired to the wrong user, or not wired at all,
 * fails here. Only the instance module (which would otherwise open the production pool) is
 * replaced, and the legacy per-user purge beside it, which has its own suite.
 *
 * The other half is the negative control: a store failure must never reject the wipe.
 */

const { holder, recorded } = vi.hoisted(() => ({
  holder: { maintenance: null as unknown as DocStoreMaintenance },
  /** What each `wipeAccount` call the wipe made came back with — proof it was called, and how. */
  recorded: [] as string[],
}));

// No hold covers the account here; the hold itself is `remove-all-content-legal-hold.behavior.test.ts`.
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAccountNotUnderLegalHold: async () => ({ markerView: false }),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({
    ...holder.maintenance,
    wipeAccount: async (userId: number) => {
      try {
        const r = await holder.maintenance.wipeAccount(userId);
        recorded.push(
          r.failures.length > 0 ? 'partial' : r.namespaces.length > 0 ? 'wiped' : 'nothing'
        );
        return r;
      } catch (err) {
        recorded.push(
          (err as { code?: string }).code === 'storage_disabled' ? 'disabled' : 'failed'
        );
        throw err;
      }
    },
  }),
}));
vi.mock('~/server/services/apps/user-storage-purge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserStoragePurge>()),
  purgeUserAppStorageForAccountWipe: vi.fn(async ({ targetUserId }: { targetUserId: number }) => ({
    userId: targetUserId,
    purgeBatchId: 'apg_test',
    results: [],
    failures: [],
    unmappedSchemas: [],
    schemasTruncated: false,
    totals: { appCount: 0, deletedRowCount: 0, deletedBytes: 0 },
  })),
}));
vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const idx = { queueUpdate: vi.fn(async () => undefined) };
  return {
    ...actual,
    modelsSearchIndex: idx,
    imagesSearchIndex: idx,
    imagesMetricsSearchIndex: idx,
    articlesSearchIndex: idx,
    collectionsSearchIndex: idx,
    bountiesSearchIndex: idx,
    usersSearchIndex: idx,
  };
});
vi.mock('~/server/metrics', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const m = { queueUpdate: vi.fn(async () => undefined) };
  return { ...actual, userMetrics: m, articleMetrics: m };
});
// The mocked raw reads answer every query, so the wipe finds models to soft-delete; that path is
// not this suite's.
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteModelById: vi.fn(async () => null),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImages: vi.fn(async () => []),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  refundBidsForVersions: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { removeAllContent } from '~/server/services/user.service';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  assertUsageConsistent,
  ctx,
  NS_PROD,
  POSTS,
  PREFS,
} from '~/server/services/apps/__tests__/doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const TARGET = 4_242;
const BYSTANDER = 4_277;
let h: Harness;
let appSeq = 0;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
});
afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // The wipe's re-check after its evidence deletes: still unheld.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([{ held: false }] as never);
  recorded.length = 0;
  holder.maintenance = createDocStoreMaintenance({ db: h.db });
  for (const model of Object.values(dbMock.dbRead) as any[]) {
    if (model && typeof model === 'object' && 'findMany' in model) {
      model.findMany.mockResolvedValue([]);
    }
  }
});

/** The target and the bystander each with a private doc and a shared post the other voted on. */
async function seed() {
  const app = `ab_RMWIPE_${(appSeq += 1)}`;
  const store = createDocStore({ db: h.db });
  for (const [uid, other] of [
    [TARGET, BYSTANDER],
    [BYSTANDER, TARGET],
  ]) {
    await store.put(ctx(app, NS_PROD, uid), PREFS, 'theme', { uid: `u${uid}` });
    await store.put(ctx(app, NS_PROD, uid), POSTS, `post-${uid}`, { status: 'open' });
    await store.mark(ctx(app, NS_PROD, other), POSTS, `post-${uid}`, 'vote');
  }
  return app;
}

async function state(app: string) {
  return {
    targetPrivate: await h.raw(`SELECT key FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2`, [
      app,
      TARGET,
    ]),
    targetPost: (
      await h.raw(
        `SELECT author_kind, author_uid FROM appdata.doc WHERE app_id = $1 AND key = $2`,
        [app, `post-${TARGET}`]
      )
    )[0],
    targetMarks: await h.raw(
      `SELECT key FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2`,
      [app, TARGET]
    ),
    bystander: await h.raw(
      `SELECT key, author_kind, author_uid, scope_uid FROM appdata.doc
        WHERE app_id = $1 AND (scope_uid = $2 OR author_uid = $2) ORDER BY key`,
      [app, BYSTANDER]
    ),
    bystanderMarks: await h.raw(
      `SELECT key FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2`,
      [app, BYSTANDER]
    ),
  };
}

/** The evidence tables the wipe deletes with raw SQL, so each statement carries the legal hold. */
const MAIN_DB_WIPE = ['Model', 'Image', 'Post', 'Article', 'Comment'];
const rawDeleted = (table: string) =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]) =>
      Prisma.sql(strings as unknown as TemplateStringsArray, ...(values as never[]))
    )
    .some((sql) => sql.text.includes(`DELETE FROM "${table}"`) && sql.values.includes(TARGET));

describe('removeAllContent → document store', () => {
  it('wipes the target account from the store and leaves the bystander alone', async () => {
    const app = await seed();
    const before = await state(app);
    // Positive control: the target has rows of every kind the wipe acts on.
    expect(before.targetPrivate).toHaveLength(1);
    expect(before.targetPost).toEqual({ author_kind: 'user', author_uid: TARGET });
    expect(before.targetMarks).toHaveLength(1);

    await removeAllContent({ id: TARGET, actorUserId: 9 });

    const after = await state(app);
    expect(after.targetPrivate).toEqual([]);
    // The target's shared post is deleted, and with it the bystander's vote on it.
    expect(after.targetPost).toBeUndefined();
    expect(after.targetMarks).toEqual([]);
    expect(after.bystander).toEqual(before.bystander);
    expect(before.bystanderMarks).toEqual([{ key: `post-${TARGET}` }]);
    expect(after.bystanderMarks).toEqual([]);
    await assertUsageConsistent(h, app, NS_PROD);
    expect(recorded).toEqual(['wiped']);
  });

  it('runs even when the legacy per-user purge before it throws', async () => {
    const app = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { purgeUserAppStorageForAccountWipe } = await import(
      '~/server/services/apps/user-storage-purge.service'
    );
    vi.mocked(purgeUserAppStorageForAccountWipe).mockRejectedValueOnce(
      new Error('apps database unreachable')
    );
    await removeAllContent({ id: TARGET });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('apps database unreachable'))).toBe(
      true
    );
    expect(recorded).toEqual(['wiped']);
    expect((await state(app)).targetPost).toBeUndefined();
    warn.mockRestore();
  });

  it('an account with nothing in the store: the wipe runs and logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await removeAllContent({ id: 4_299 });
    expect(recorded).toEqual(['nothing']);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('document store'))
    ).toEqual([]);
    warn.mockRestore();
  });

  it('🔴 NEGATIVE CONTROL: a store failure does not reject the wipe or undo it; it is logged, and a re-run finishes the job', async () => {
    const app = await seed();
    const before = await state(app);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const down: DocStoreDb = {
      async connect() {
        throw new Error('appdata unreachable');
      },
    };
    holder.maintenance = createDocStoreMaintenance({ db: down });

    await expect(removeAllContent({ id: TARGET, actorUserId: 9 })).resolves.toEqual({
      incomplete: ['doc-store'],
    });

    // The main-database wipe ran in full regardless.
    expect(dbMock.dbWrite.collection.deleteMany).toHaveBeenCalledWith({
      where: { userId: TARGET },
    });
    for (const table of MAIN_DB_WIPE) expect(rawDeleted(table), table).toBe(true);
    expect(recorded).toEqual(['failed']);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('document store wipe failed'));
    expect(line).toContain(`userId=${TARGET}`);
    expect(line).toContain('appdata unreachable');
    expect(line).toContain('re-run user.removeAllContent');
    // Nothing in the store moved.
    expect(await state(app)).toEqual(before);

    // The retry the warning names: re-running the wipe completes it.
    holder.maintenance = createDocStoreMaintenance({ db: h.db });
    recorded.length = 0;
    await removeAllContent({ id: TARGET, actorUserId: 9 });
    expect(recorded).toEqual(['wiped']);
    expect((await state(app)).targetPost).toBeUndefined();
    warn.mockRestore();
  });

  it('a namespace that failed is logged as incomplete, with the remedy', async () => {
    const app = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    holder.maintenance = {
      ...createDocStoreMaintenance({ db: h.db }),
      wipeAccount: async (userId: number) => ({
        userId,
        namespaces: [],
        failures: [{ appId: app, ns: NS_PROD, error: 'lock timeout' }],
      }),
    };
    await expect(removeAllContent({ id: TARGET })).resolves.toEqual({ incomplete: ['doc-store'] });
    expect(recorded).toEqual(['partial']);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('wipe INCOMPLETE'));
    expect(line).toContain(`${app}/${NS_PROD}: lock timeout`);
    expect(line).toContain('re-run user.removeAllContent');
    warn.mockRestore();
  });

  it('no store configured: not logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    holder.maintenance = createDocStoreMaintenance({ db: null });
    await removeAllContent({ id: TARGET });
    expect(recorded).toEqual(['disabled']);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('document store'))
    ).toEqual([]);
    // The same code from a throwing store object, not only the real one.
    holder.maintenance = {
      ...createDocStoreMaintenance({ db: null }),
      wipeAccount: async () => {
        throw new DocStoreError('storage_disabled', 'off');
      },
    };
    recorded.length = 0;
    await removeAllContent({ id: TARGET });
    expect(recorded).toEqual(['disabled']);
    warn.mockRestore();
  });
});
