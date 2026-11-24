import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';

/**
 * `apps.mod.docStore.maintenance.*`: the REAL router and its `moderatorProcedure` for who may call
 * it, and the REAL service (`storage-mark-migration.service.ts`), handed the REAL document store on
 * PGlite (real migrations, least-privilege role, RLS on) through its `store` dependency, for what
 * each op does. Replaced at the boundary only: the main-database rows (`AppBlock`, the audit
 * table) through the canonical db mock, the Flipt switch, and the derivation secret (the canonical
 * env mock).
 *
 * What this file owns, beyond the store suite (`doc-store.mark-migration.pglite.test.ts`): who may
 * call the ops, that each writing op is audited before it changes anything, the gates only the
 * main database and Flipt can answer (the enforced manifest, the target's switch, the secret),
 * and that a copied vote lands at exactly the key its voter's own `@me` call derives.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  maint: undefined as unknown as DocStoreMaintenance,
  /** Viewer-keyed collections whose switch is open. */
  open: new Set<string>(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  return {
    ...real,
    isFlipt: vi.fn(async (flag: string, _entity?: string, context?: unknown) => {
      if (flag === 'app-blocks-storage-viewer-keyed-open') {
        return h.open.has((context as { collection?: string } | undefined)?.collection ?? '');
      }
      return false;
    }),
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { appsModRouter } from '~/server/routers/apps-shared.router';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { viewerKeyedDocKey } from '~/server/services/apps/doc-store-viewer-keyed';
import {
  migrateMarksToDocs,
  purgeStorageCollection,
  rollbackMarkMigration,
  storageMaintenanceStatus,
  storagePurgeDump,
} from '~/server/services/apps/storage-mark-migration.service';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import { ctx as sctx, decl, NS_PROD } from '~/server/services/apps/__tests__/doc-store.functional';

const mockWrite = dbMock.dbWrite;

// Pairwise distinct, and distinct from the store suite's.
const MOD = { id: 8_911, isModerator: true, deletedAt: null, bannedAt: null };
const USER = { id: 8_922, isModerator: false, deletedAt: null, bannedAt: null };
const V1 = 6_101;
const V2 = 6_202;
const SECRET = 'maintenance-router-secret-7c1e0a95bd';
const REASON = 'migrate the votes';

const MANIFEST = {
  storage: {
    collections: {
      records: { visibility: 'shared', write: 'own', marks: ['vote'] },
      votes: { visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' },
      popular_plays: {
        visibility: 'shared',
        write: 'none',
        counters: ['plays'],
        marks: ['played'],
      },
    },
  },
};
/** The next approved version: the counter collection's counters dropped (its mark kept). */
const MANIFEST_NO_COUNTERS = {
  storage: {
    collections: {
      ...MANIFEST.storage.collections,
      popular_plays: { visibility: 'shared', write: 'none', marks: ['played'] },
    },
  },
};

const RECORDS: DocCollection = {
  name: 'records',
  config: decl({ visibility: 'shared', write: 'own', marks: ['vote'] }),
};
const VOTES: DocCollection = {
  name: 'votes',
  config: decl({ visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' }),
};
const POPULAR: DocCollection = {
  name: 'popular_plays',
  config: decl({ visibility: 'shared', write: 'none', counters: ['plays'], marks: ['played'] }),
};

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
const caller = (user: unknown = MOD) =>
  appsModRouter.createCaller(ctx(user) as never).docStore.maintenance;

let harness: Harness;
type AuditRow = { id: string; action: string; before: any; after?: any; [k: string]: unknown };
let audit: AuditRow[];
let seq = 0;
let app: { id: string; blockId: string; manifest: unknown };

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  h.store = createDocStore({ db: harness.db });
  h.maint = createDocStoreMaintenance({ db: harness.db });
});
afterAll(async () => {
  if (harness) expect(harness.violations).toEqual([]);
  await harness?.close();
});

beforeEach(async () => {
  seq += 1;
  app = { id: `apb_MAINT${seq}`, blockId: `maint-${seq}`, manifest: MANIFEST };
  audit = [];
  h.open.clear();
  envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: SECRET });
  mockWrite.appBlock.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === app.id
      ? {
          id: app.id,
          blockId: app.blockId,
          manifest: app.manifest,
          updatedAt: new Date('2026-11-01T00:00:00Z'),
          appListing: { id: `apl_maint${seq}`, slug: app.blockId },
        }
      : null
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

const v = (uid: number | null) => sctx(app.id, NS_PROD, uid);
async function seedVotes() {
  await h.store.put(v(V1), RECORDS, 'rec_x', { t: 'x' });
  await h.store.put(v(V2), RECORDS, 'rec_y', { t: 'y' });
  await h.store.mark(v(V1), RECORDS, 'rec_x', 'vote');
  await h.store.mark(v(V2), RECORDS, 'rec_x', 'vote');
  await h.store.mark(v(V2), RECORDS, 'rec_y', 'vote');
}
/** The service with the PGlite store passed in (the router passes none: production's). */
const deps = () => ({ store: h.maint });
const migrate = (dryRun = true, to = 'votes') =>
  migrateMarksToDocs(
    {
      actorUserId: MOD.id,
      appBlockId: app.id,
      from: 'records',
      mark: 'vote',
      to,
      reason: REASON,
      dryRun,
    },
    deps()
  );
const status = () => storageMaintenanceStatus({ appBlockId: app.id }, deps());
const refusal = (reason: string) => ({ code: 'invalid_request', details: { reason } });
const votes = () =>
  harness.raw(`SELECT key FROM appdata.doc WHERE app_id = $1 AND coll = 'votes' ORDER BY key`, [
    app.id,
  ]);

describe('access: session moderators only', () => {
  const calls = (user: unknown) =>
    [
      ['status', () => caller(user).status({ appBlockId: app.id })],
      [
        'migrateMarks',
        () =>
          caller(user).migrateMarks({
            appBlockId: app.id,
            from: 'records',
            mark: 'vote',
            to: 'votes',
            dryRun: false,
            reason: REASON,
          }),
      ],
      [
        'rollbackMarks',
        () => caller(user).rollbackMarks({ appBlockId: app.id, to: 'votes', reason: REASON }),
      ],
      [
        'purgeCollection',
        () =>
          caller(user).purgeCollection({
            appBlockId: app.id,
            collection: 'popular_plays',
            reason: REASON,
          }),
      ],
    ] as const;

  it.each([
    ['a non-moderator session', USER, 'FORBIDDEN'],
    ['no session', null, 'UNAUTHORIZED'],
  ])(
    '%s is refused on every procedure, and nothing is frozen, copied or audited',
    async (_l, user, code) => {
      await seedVotes();
      for (const [name, run] of calls(user)) {
        await expect(run(), name).rejects.toMatchObject({ code });
      }
      expect(audit).toEqual([]);
      expect(await votes()).toEqual([]);
      // Not frozen: the old mark still answers.
      expect(await h.store.mark(v(V1), RECORDS, 'rec_y', 'vote')).toMatchObject({ marked: true });
    }
  );

  it('positive control: a moderator session reaches the service (an unknown app is NOT_FOUND)', async () => {
    await expect(caller().status({ appBlockId: 'apb_NOSUCHAPP' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'app block not found',
    });
  });
});

describe('migrateMarks', () => {
  it('is a dry run by default: the key check and the counts, nothing written, nothing audited', async () => {
    await seedVotes();
    const out = await migrate();
    expect(out).toMatchObject({
      dryRun: true,
      check: { ok: true, rows: 3, keys: 2, users: 2, unfit: 0 },
      run: null,
      target: { declared: true, viewerKeyed: true, open: false },
    });
    expect(audit).toEqual([]);
    expect(await votes()).toEqual([]);
    expect((await status()).runs).toEqual([]);
  });

  it("copies each vote to the key its voter's own @me call derives; audited before it ran", async () => {
    await seedVotes();
    const out = await migrate(false);
    expect(out).toMatchObject({
      dryRun: false,
      created: true,
      copy: { rows: 3, inserted: 3, existing: 0 },
      verify: { ok: true, sourceRows: 3, targetDocs: 3 },
    });
    // The seam: the voter's `@me` key (derived from the env secret, as the route does) holds
    // the copy, for each (voter, parent).
    for (const [uid, parent] of [
      [V1, 'rec_x'],
      [V2, 'rec_x'],
      [V2, 'rec_y'],
    ] as const) {
      const key = await viewerKeyedDocKey({ ctx: v(uid), coll: VOTES, parent, write: false });
      const doc = await h.store.get(v(uid), VOTES, key);
      expect({ uid, parent, author: doc?.author }).toEqual({
        uid,
        parent,
        author: { kind: 'user', isViewer: true, uid },
      });
    }
    // One audit row, the moderator's, with the parameters and the outcome.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'storage-mark-migration',
      actorUserId: MOD.id,
      reason: REASON,
      before: { appBlockId: app.id, ns: 'prod', from: 'records', mark: 'vote', to: 'votes' },
      after: {
        outcome: 'applied',
        copy: { inserted: 3, overCeilingCount: 0 },
        verify: { ok: true, userSampleCount: 0 },
      },
    });
    // The main-database audit row holds counts, never the per-user lists (the account wipe does
    // not reach it).
    expect(audit[0].after.copy).not.toHaveProperty('overCeiling');
    expect(audit[0].after.verify).not.toHaveProperty('userSample');
    expect(APP_LISTING_MODERATION_ACTIONS as readonly string[]).toContain(audit[0].action);
    expect((await status()).runs).toMatchObject([
      { collection: 'records', kind: 'mark_migration', name: 'vote', status: 'verified' },
    ]);
  });

  it('refuses a target whose switch is open, before any audit row, freeze or copy', async () => {
    await seedVotes();
    h.open.add('votes');
    await expect(migrate(false)).rejects.toMatchObject(refusal('target_open'));
    expect(audit).toEqual([]);
    expect(await votes()).toEqual([]);
    expect(await h.store.mark(v(V1), RECORDS, 'rec_y', 'vote')).toMatchObject({ marked: true });
  });

  it('refuses while the derivation secret is unset, before any audit row, freeze or copy', async () => {
    await seedVotes();
    envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: undefined });
    await expect(migrate(false)).rejects.toMatchObject({
      code: 'service_unavailable',
      details: { reason: 'viewer_keys_unconfigured' },
    });
    expect(audit).toEqual([]);
    expect(await votes()).toEqual([]);
  });

  it('refuses a target the enforced manifest does not declare', async () => {
    await seedVotes();
    await expect(migrate(false, 'ballots')).rejects.toMatchObject(refusal('target_not_declared'));
    expect(audit).toEqual([]);
  });
});

describe('purgeCollection and rollbackMarks', () => {
  async function seedCounters() {
    await h.store.increment(v(V1), POPULAR, 'song_1', 'plays', 2);
    await h.store.increment(v(V2), POPULAR, 'song_2', 'plays', 1);
  }

  it('reads the counters from the ENFORCED manifest: refused while declared, applied once dropped', async () => {
    await seedCounters();
    const purge = () =>
      purgeStorageCollection(
        { actorUserId: MOD.id, appBlockId: app.id, collection: 'popular_plays', reason: REASON },
        deps()
      );
    await expect(purge()).rejects.toMatchObject(refusal('counters_declared'));
    // The refusal is audited as failed: the audit row comes first.
    expect(audit.map((r) => [r.action, r.after?.outcome, r.after?.reason])).toEqual([
      ['storage-collection-purge', 'failed', 'counters_declared'],
    ]);

    app.manifest = MANIFEST_NO_COUNTERS;
    const out = await purge();
    expect(out).toMatchObject({
      mode: 'purge',
      deleted: 2,
      refunds: [
        { userId: V1, docs: 1 },
        { userId: V2, docs: 1 },
      ],
    });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-collection-purge', 'failed'],
      ['storage-collection-purge', 'applied'],
    ]);
    // Who was refunded stays in the store's run (which the wipe scrubs); the audit row counts them.
    expect(audit[1].after).toMatchObject({ refundsCount: 2, totals: { refundsCount: 2 } });
    expect(JSON.stringify(audit[1].after)).not.toMatch(new RegExp(`\\b(${V1}|${V2})\\b`));
    const dump = await storagePurgeDump(
      { appBlockId: app.id, collection: 'popular_plays', runId: out.runId },
      deps()
    );
    expect(dump?.docs.map((d) => d.key)).toEqual(['song_1', 'song_2']);
  });

  it('a rollback is refused once the target switch is open, and applied while it is closed', async () => {
    await seedVotes();
    await migrate(false);
    h.open.add('votes');
    const rollback = () =>
      rollbackMarkMigration(
        { actorUserId: MOD.id, appBlockId: app.id, to: 'votes', reason: 'revert the migration' },
        deps()
      );
    await expect(rollback()).rejects.toMatchObject(refusal('target_open'));
    expect(await votes()).toHaveLength(3);

    h.open.clear();
    expect(await rollback()).toMatchObject({
      mode: 'rollback',
      deleted: 3,
      rolledBack: { from: 'records', mark: 'vote' },
    });
    expect(await votes()).toEqual([]);
    expect(await h.store.mark(v(V1), RECORDS, 'rec_y', 'vote')).toMatchObject({ marked: true });
  });
});
