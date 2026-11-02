import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  ctx,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
} from '~/server/services/apps/__tests__/doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const live = vi.hoisted(() => ({ store: undefined as unknown, held: new Set<number>() }));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => live.store,
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAccountUnderLegalHold: async (id: number) => live.held.has(id),
}));
vi.mock('../job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => unknown) => ({ name, cron, fn }),
}));

const { removeDeletedAccountAppData } = await import(
  '~/server/jobs/remove-deleted-account-app-data'
);

/**
 * The app-data removal job against the REAL store (embedded Postgres, the real migrations, the
 * least-privilege role, RLS on) and an in-memory `User` table behind the PRIMARY client's raw
 * queries: `deletedAt` and `meta.appDataRemoval` are all the job reads.
 */

// Pairwise distinct, and distinct from every id the other suites use.
const OPTED_IN = 8_101;
const OPTED_OUT = 8_202;
const RESTORED = 8_303;
const HELD = 8_404;
const LIVE_USER = 8_505;
const ALL = [OPTED_IN, OPTED_OUT, RESTORED, HELD, LIVE_USER];

type UserRow = { deletedAt: Date | null; meta: Record<string, unknown> };
const users = new Map<number, UserRow>();

let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;
let apps: string[];

const requested = (u: UserRow) => u.deletedAt !== null && u.meta.appDataRemoval === 'requested';

async function docsOf(uid: number): Promise<number> {
  const [r] = await h.raw(
    `SELECT count(*)::int AS n FROM appdata.doc
      WHERE app_id = ANY($2::text[])
        AND (scope_uid = $1 OR (scope_uid = 0 AND author_kind = 'user' AND author_uid = $1))`,
    [uid, apps]
  );
  return Number(r.n);
}

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
  maint = createDocStoreMaintenance({ db: h.db });
  live.store = maint;
});

afterAll(async () => {
  if (h) expect(h.violations).toEqual([]);
  await h?.close();
});

beforeEach(async () => {
  users.clear();
  live.held.clear();
  // Two apps; every user has a private and an authored shared document in each.
  apps = [freshApp('ACCTA'), freshApp('ACCTB')];
  for (const app of apps) {
    for (const uid of ALL) {
      await store.put(ctx(app, NS_PROD, uid), PREFS, 'p', { uid });
      await store.put(ctx(app, NS_PROD, uid), POSTS, `post-${uid}`, { status: 'open' });
    }
  }
  const deleted = new Date('2026-10-01T00:00:00Z');
  users.set(OPTED_IN, { deletedAt: deleted, meta: { appDataRemoval: 'requested' } });
  users.set(OPTED_OUT, { deletedAt: deleted, meta: {} });
  // Restored before the job ran: `restoreUser` cleared deletedAt and dropped the request.
  users.set(RESTORED, { deletedAt: null, meta: {} });
  users.set(HELD, { deletedAt: deleted, meta: { appDataRemoval: 'requested' } });
  users.set(LIVE_USER, { deletedAt: null, meta: {} });
  live.held.add(HELD);

  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (/ORDER BY u\."deletedAt"/.test(sql)) {
        return [...users]
          .filter(([, u]) => requested(u))
          .sort(([a], [b]) => a - b)
          .map(([id]) => ({ id }));
      }
      if (/AS requested/.test(sql)) {
        const u = users.get(values[0] as number);
        return [{ requested: !!u && requested(u) }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (!/- 'appDataRemoval'/.test(sql)) throw new Error(`unexpected write: ${sql}`);
      const u = users.get(values[0] as number);
      if (!u || u.deletedAt === null) return 0;
      delete u.meta.appDataRemoval;
      return 1;
    }
  );
});

describe('removeDeletedAccountAppData', () => {
  it("opt-in on: wipes that account's data in every app and nobody else's; opt-in off leaves it", async () => {
    for (const uid of ALL) expect({ uid, docs: await docsOf(uid) }).toEqual({ uid, docs: 4 });

    const out = await removeDeletedAccountAppData({ store: maint });

    expect(out).toMatchObject({ scanned: 2, wiped: 1, held: 1, failed: 0 });
    expect(await docsOf(OPTED_IN)).toBe(0);
    // Box left off, restored, held, never deleted: every document stays.
    for (const uid of [OPTED_OUT, RESTORED, HELD, LIVE_USER]) {
      expect({ uid, docs: await docsOf(uid) }).toEqual({ uid, docs: 4 });
    }
    // The request is done; the held one is kept for a later run.
    expect(users.get(OPTED_IN)?.meta.appDataRemoval).toBeUndefined();
    expect(users.get(HELD)?.meta.appDataRemoval).toBe('requested');
  });

  it('is idempotent: a second run wipes nothing more', async () => {
    await removeDeletedAccountAppData({ store: maint });
    const out = await removeDeletedAccountAppData({ store: maint });
    expect(out).toMatchObject({ wiped: 0, failed: 0, held: 1 });
    expect(await docsOf(OPTED_OUT)).toBe(4);
  });

  it('re-checks the account just before wiping: one restored after the worklist read is not wiped', async () => {
    const base = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const rows = await base?.(strings, ...values);
        // The restore lands between the worklist read and the per-account check.
        if (/ORDER BY u\."deletedAt"/.test(strings.join('?'))) {
          users.set(OPTED_IN, { deletedAt: null, meta: {} });
        }
        return rows;
      }
    );

    const out = await removeDeletedAccountAppData({ store: maint });

    expect(out.wiped).toBe(0);
    expect(await docsOf(OPTED_IN)).toBe(4);
  });
});
