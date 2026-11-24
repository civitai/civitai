import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `apps.mod.docStore.maintenance.*`: the REAL router and its `moderatorProcedure` for who may call
 * it, and the REAL service (`storage-mark-migration.service.ts`), handed the REAL document store on
 * PGlite (real migrations, least-privilege role, RLS on) through its `store` dependency, for what
 * each read answers. Replaced at the boundary only: the main-database `AppBlock` row through the
 * canonical db mock.
 *
 * What is left is read only: the run records the rollout step 4 data migration wrote
 * (`docs/app-storage-generic-core.md`). The tooling that wrote them (`migrateMarks`,
 * `rollbackMarks`, `purgeCollection`) is removed, so the rows are seeded here as it wrote them. The
 * store's own handling of the runs (retention, the account wipe) is `doc-store.maint-runs.pglite.test.ts`.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import { dbMock } from '~/__tests__/mocks/db.mock';
import { appsModRouter } from '~/server/routers/apps-shared.router';
import {
  createDocStoreMaintenance,
  type DocStoreMaintenance,
} from '~/server/services/apps/doc-store';
import {
  storageMaintenanceStatus,
  storagePurgeDump,
} from '~/server/services/apps/storage-mark-migration.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';

const mockWrite = dbMock.dbWrite;

// Pairwise distinct, and distinct from the store suites'.
const MOD = { id: 8_911, isModerator: true, deletedAt: null, bannedAt: null };
const USER = { id: 8_922, isModerator: false, deletedAt: null, bannedAt: null };
const RUN = '01JDMAINTROUTER00000000000';

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
let maint: DocStoreMaintenance;
let seq = 0;
let appId: string;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  maint = createDocStoreMaintenance({ db: harness.db });
});
afterAll(async () => {
  if (harness) expect(harness.violations).toEqual([]);
  await harness?.close();
});

beforeEach(() => {
  seq += 1;
  appId = `apb_MAINT${seq}`;
  mockWrite.appBlock.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === appId ? { id: appId } : null
  );
});

const deps = () => ({ store: maint });

async function seedPurge() {
  const insert = (kind: string, name: string, status: string, result: unknown, dump: unknown) =>
    harness.raw(
      `INSERT INTO appdata.maint_run (app_id, ns, coll, kind, name, status, result, dump, actor_uid)
       VALUES ($1, 'prod', 'popular_plays', $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        appId,
        kind,
        name,
        status,
        JSON.stringify(result),
        dump ? JSON.stringify(dump) : null,
        MOD.id,
      ]
    );
  await insert('purge', RUN, 'purged', { deleted: 1 }, null);
  await insert(
    'purge_dump',
    `${RUN}.000001`,
    'dumped',
    { deleted: 1 },
    {
      docs: [],
      index: [],
      tallies: [{ key: 'song_a', kind: 'counter', name: 'plays', count: 2 }],
      marks: [],
    }
  );
}

describe('access: session moderators only', () => {
  const calls = (user: unknown) =>
    [
      ['status', () => caller(user).status({ appBlockId: appId })],
      [
        'purgeDump',
        () =>
          caller(user).purgeDump({ appBlockId: appId, collection: 'popular_plays', runId: RUN }),
      ],
    ] as const;

  it.each([
    ['a non-moderator session', USER, 'FORBIDDEN'],
    ['no session', null, 'UNAUTHORIZED'],
  ])('%s is refused on every procedure', async (_l, user, code) => {
    for (const [name, run] of calls(user)) {
      await expect(run(), name).rejects.toMatchObject({ code });
    }
  });

  it('positive control: a moderator session reaches the service (an unknown app is NOT_FOUND)', async () => {
    await expect(caller().status({ appBlockId: 'apb_NOSUCHAPP' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'app block not found',
    });
  });
});

describe('the removed tooling', () => {
  it('migrateMarks, rollbackMarks and purgeCollection are no longer procedures', () => {
    const procedures = Object.keys(
      (appsModRouter as never as { _def: { procedures: Record<string, unknown> } })._def.procedures
    )
      .filter((p) => p.startsWith('docStore.maintenance.'))
      .sort();
    // Positive control in the same list: the reads that stay are there.
    expect(procedures).toEqual(['docStore.maintenance.purgeDump', 'docStore.maintenance.status']);
  });
});

describe('reads', () => {
  it('status lists the runs (no dump rows); purgeDump reads one purge whole', async () => {
    await seedPurge();
    const { runs } = await storageMaintenanceStatus({ appBlockId: appId }, deps());
    expect(runs.map((r) => [r.kind, r.name, r.status])).toEqual([['purge', RUN, 'purged']]);
    const dump = await storagePurgeDump(
      { appBlockId: appId, collection: 'popular_plays', runId: RUN },
      deps()
    );
    expect(dump?.tallies).toEqual([{ key: 'song_a', kind: 'counter', name: 'plays', count: 2 }]);
  });

  it('an unknown app is refused before the store is read', async () => {
    await expect(
      storageMaintenanceStatus({ appBlockId: 'apb_NOSUCH' }, deps())
    ).rejects.toMatchObject({
      name: 'StorageMaintenanceError',
      kind: 'app_not_found',
    });
  });
});
