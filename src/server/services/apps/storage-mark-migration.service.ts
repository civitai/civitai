// App Storage DATA MIGRATION records (`docs/app-storage-generic-core.md`, "Data migration", rollout
// steps 4 and 5). The rollout step 4 tooling that WROTE them (the mark migration, its rollback and
// the per-collection purge) is removed with the primitives it migrated away from; what is left is
// moderator-run and read only, served by `apps.mod.docStore.maintenance.*`
// (`apps-mod-doc-store.router.ts`, session `moderatorProcedure`; no block-token route reaches it):
//   - `storageMaintenanceStatus`: the runs recorded in the app's production namespace;
//   - `storagePurgeDump`: one purge's dump (every row it deleted), while its retention lasts;
// and the retention job's sweep (`expireStorageMaintenanceDumps`). The account wipe scrubs a
// deleted user out of the runs and dumps in the store itself (`scrubMaintRuns` in `doc-store.ts`).
import { dbRead } from '~/server/db/client';
import type { DocStoreMaintenance, MaintRun, PurgeDump } from '~/server/services/apps/doc-store';
import { getDocStoreMaintenance } from '~/server/services/apps/doc-store-maintenance.instance';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

export class StorageMaintenanceError extends Error {
  constructor(readonly kind: 'app_not_found') {
    super(kind);
    this.name = 'StorageMaintenanceError';
  }
}

type Deps = { store?: DocStoreMaintenance };

/** The app block (an existence check, from the replica); refused when it does not exist. */
async function loadApp(appBlockId: string): Promise<{ appBlockId: string }> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true },
  });
  if (!block) throw new StorageMaintenanceError('app_not_found');
  return { appBlockId: block.id };
}

/** Every maintenance run of the app's production namespace (no dumps). */
export async function storageMaintenanceStatus(
  input: { appBlockId: string },
  deps: Deps = {}
): Promise<{ runs: MaintRun[] }> {
  const store = deps.store ?? getDocStoreMaintenance();
  const app = await loadApp(input.appBlockId);
  return { runs: await store.listMaintRuns(app.appBlockId) };
}

/** One purge's dump: every row it deleted. */
export async function storagePurgeDump(
  input: { appBlockId: string; collection: string; runId: string },
  deps: Deps = {}
): Promise<PurgeDump | null> {
  const store = deps.store ?? getDocStoreMaintenance();
  const app = await loadApp(input.appBlockId);
  return store.purgeDump(app.appBlockId, { collection: input.collection, runId: input.runId });
}

/** App blocks read per page by the dump expiry. */
const EXPIRY_APP_PAGE = 500;

/**
 * RETENTION of purge dumps (`expire-storage-maintenance-dumps` job): in every on-platform app's
 * production namespace, the dumps of each purge that finished at least
 * `PURGE_DUMP_RETENTION_DAYS` ago are deleted (`expireMaintDumps`); its header, with its counts,
 * stays. One store transaction per app. An app whose call fails is counted and the rest go on; a
 * store that is switched off stops the sweep.
 */
export async function expireStorageMaintenanceDumps(
  opts: { store?: DocStoreMaintenance; checkIfCanceled?: () => void } = {}
): Promise<{ apps: number; dumps: number; failures: number }> {
  const store = opts.store ?? getDocStoreMaintenance();
  const out = { apps: 0, dumps: 0, failures: 0 };
  let after: string | undefined;
  for (;;) {
    const page = await dbRead.appBlock.findMany({
      where: { externalUrl: null, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: EXPIRY_APP_PAGE,
    });
    for (const { id } of page) {
      opts.checkIfCanceled?.();
      out.apps += 1;
      try {
        out.dumps += (await store.expireMaintDumps(id)).dumps;
      } catch (err) {
        if (isDocStoreError(err, 'storage_disabled')) throw err;
        out.failures += 1;
      }
    }
    if (page.length < EXPIRY_APP_PAGE) return out;
    after = page[page.length - 1].id;
  }
}
