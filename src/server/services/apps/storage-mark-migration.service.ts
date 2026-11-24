// App Storage DATA MIGRATION tooling (`docs/app-storage-generic-core.md`, "Data migration",
// "Counter documents", rollout steps 2 and 4): the MARK MIGRATION (`migrateMarksToDocs`: key
// check, freeze, copy, verify, as one idempotent op with a dry run), its ROLLBACK, and the
// PER-COLLECTION PURGE. Moderator-run maintenance, served by `apps.mod.docStore.maintenance.*`
// (`apps-mod-doc-store.router.ts`, session `moderatorProcedure`); no block-token route reaches it.
//
// THIS MODULE decides what only the main database and Flipt know, then hands the store a
// decision it re-checks under its own locks (`doc-store.ts`, "THE MARK MIGRATION and THE
// PER-COLLECTION PURGE"):
//   - the app's ENFORCED manifest (`app_blocks.manifest`, read on the primary): the target's
//     declaration (viewer-keyed `parent+viewer`, its schema and schema major) and, for a purge,
//     whether the collection still declares counters (`$inc` would re-create a document);
//   - each target's switch (`app-blocks-storage-viewer-keyed-open`, `isViewerKeyedOpen`): a copy
//     into an OPEN target is refused (it could re-create a vote its viewer deleted through `@me`),
//     and a purge needs every one of its marks' targets open; a rollback needs its target closed;
//   - the derivation secret (`viewerKeyDeriver`): a copied vote lands at exactly the key its voter's
//     own `@me` call derives. Unset, every non-dry-run op refuses (503) before anything is written.
//
// AUDIT. Every op that writes records an `AppListingModerationEvent` FIRST (the rail and the order
// of `doc-store-moderation.service.ts`): a missing audit row means the op did not run. `before`
// holds the op's parameters, never a document's content; `after` the outcome and its counts. A dry
// run, the status read and the dump read write nothing and are not audited.
import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type {
  DocStoreMaintenance,
  MaintRun,
  MarkCopyResult,
  PurgeCollectionResult,
  PurgeDump,
} from '~/server/services/apps/doc-store';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import { declaredCollections } from '~/server/services/apps/doc-store-declared';
import { getDocStoreMaintenance } from '~/server/services/apps/doc-store-maintenance.instance';
import type {
  MarkKeyCheck,
  MarkMigrationVerify,
} from '~/server/services/apps/doc-store-mark-migration';
import {
  enforcedManifestOf,
  resolveSchemaMajor,
} from '~/server/services/apps/doc-store-schema-major';
import { isViewerKeyedOpen, viewerKeyDeriver } from '~/server/services/apps/doc-store-viewer-keyed';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError, isDocStoreError } from '~/server/services/apps/doc-store.types';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

/** The audit actions (`APP_LISTING_MODERATION_ACTIONS`). */
export const STORAGE_MAINTENANCE_ACTIONS = {
  markMigration: 'storage-mark-migration',
  collectionPurge: 'storage-collection-purge',
} as const;

export class StorageMaintenanceError extends Error {
  constructor(readonly kind: 'app_not_found') {
    super(kind);
    this.name = 'StorageMaintenanceError';
  }
}

type App = {
  appBlockId: string;
  slug: string;
  appListingId: string | null;
  manifest: unknown;
  updatedAt: Date | null;
};

type Deps = { store?: DocStoreMaintenance };

/** The app, with its ENFORCED manifest, from the primary. */
async function loadApp(appBlockId: string): Promise<App> {
  // primary: the enforced manifest decides the copy's target and the purge's counter gate.
  const block = await dbWrite.appBlock.findUnique({
    where: { id: appBlockId },
    select: {
      id: true,
      blockId: true,
      manifest: true,
      updatedAt: true,
      appListing: { select: { id: true, slug: true } },
    },
  });
  if (!block) throw new StorageMaintenanceError('app_not_found');
  return {
    appBlockId: block.id,
    slug: block.appListing?.slug ?? block.blockId,
    appListingId: block.appListing?.id ?? null,
    manifest: block.manifest,
    updatedAt: block.updatedAt ?? null,
  };
}

const prodCtx = (app: App): DocStoreContext => ({
  appId: app.appBlockId,
  ns: PUBLISHED_NS,
  viewerUid: null,
});

const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DocStoreError('invalid_request', message, { reason, ...details });

/** The collection as the app's enforced manifest declares it, with its schema major; or null. */
async function declaredCollection(app: App, name: string): Promise<DocCollection | null> {
  const config = declaredCollections(app.appBlockId, app.manifest).get(name);
  if (!config) return null;
  const schemaMajor = await resolveSchemaMajor({
    appBlockId: app.appBlockId,
    head: enforcedManifestOf(app),
    collection: name,
  });
  return { name, config, schemaMajor };
}

/**
 * Audit row first, then the op, then the outcome stamp: a store refusal (`DocStoreError`, raised
 * inside its transaction before COMMIT) is recorded `failed`, any other error `unknown` (it may
 * have struck after a COMMIT).
 */
async function audited<T extends Record<string, unknown>>(
  args: {
    app: App;
    action: keyof typeof STORAGE_MAINTENANCE_ACTIONS;
    actorUserId: number;
    reason: string;
    detail: string;
    before: Record<string, unknown>;
  },
  run: () => Promise<T>
): Promise<T & { auditEventId: string }> {
  const id = newAppListingModerationEventId();
  await dbWrite.appListingModerationEvent.create({
    data: {
      id,
      appListingId: args.app.appListingId,
      slug: args.app.slug,
      action: STORAGE_MAINTENANCE_ACTIONS[args.action],
      actorUserId: args.actorUserId,
      reason: args.reason,
      detail: args.detail,
      before: {
        appBlockId: args.app.appBlockId,
        ns: PUBLISHED_NS,
        ...args.before,
      } as Prisma.InputJsonValue,
    },
  });
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await dbWrite.appListingModerationEvent
      .update({
        where: { id },
        data: {
          after: {
            outcome: isDocStoreError(err) ? 'failed' : 'unknown',
            error: err instanceof Error ? err.message : String(err),
            reason: isDocStoreError(err) ? err.details?.reason ?? null : null,
            failedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    throw err;
  }
  // Best-effort: the op has happened; failing here would report that it had not.
  await dbWrite.appListingModerationEvent
    .update({
      where: { id },
      data: {
        after: {
          outcome: 'applied',
          ...result,
          completedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return { ...result, auditEventId: id };
}

export type MarkMigrationDryRun = {
  dryRun: true;
  check: MarkKeyCheck;
  run: MaintRun | null;
  target: { declared: boolean; viewerKeyed: boolean; open: boolean };
};

export type MarkMigrationOutcome = {
  dryRun: false;
  created: boolean;
  check: MarkKeyCheck;
  copy: MarkCopyResult;
  verify: MarkMigrationVerify;
  auditEventId: string;
};

/**
 * `migrateMarksToDocs(appId, ns, { from, mark, to, data, keyMap? })` for the app's production
 * namespace: the key check, the freeze, the one copy and the verify, in that order, for one
 * (source collection, mark name) into one viewer-keyed target. Idempotent: a re-run with the same
 * parameters copies nothing new and verifies again. Never touches `report` rows (refused as a
 * mark name, and the copy reads only rows of `mark`).
 *
 * `dryRun` runs the key check and the counts only, and writes nothing: the rollout's step-1
 * re-measure. Without `dryRun` the target must be declared viewer-keyed (`parent+viewer`) by the
 * enforced manifest and its switch closed, and the derivation secret set.
 */
export async function migrateMarksToDocs(
  input: {
    actorUserId: number;
    appBlockId: string;
    from: string;
    mark: string;
    to: string;
    data?: Record<string, unknown>;
    keyMap?: Record<string, string>;
    reason: string;
    dryRun: boolean;
  },
  deps: Deps = {}
): Promise<MarkMigrationDryRun | MarkMigrationOutcome> {
  const store = deps.store ?? getDocStoreMaintenance();
  const app = await loadApp(input.appBlockId);
  const target = await declaredCollection(app, input.to);
  if (input.dryRun) {
    const { check, run } = await store.checkMarkMigration(app.appBlockId, {
      from: input.from,
      mark: input.mark,
      keyMap: input.keyMap,
    });
    return {
      dryRun: true,
      check,
      run,
      target: {
        declared: target !== null,
        viewerKeyed: target?.config.keyedBy === 'parent+viewer',
        open: target !== null && (await isViewerKeyedOpen(prodCtx(app), input.to)),
      },
    };
  }
  if (!target) {
    throw refuse(
      'target_not_declared',
      `collection ${input.to} is not declared by the app's approved manifest`
    );
  }
  if (await isViewerKeyedOpen(prodCtx(app), input.to)) {
    throw refuse(
      'target_open',
      `collection ${input.to} is open for writes: a copy now could re-create a vote its viewer deleted`
    );
  }
  // Before the audit row: a missing secret is the platform's state, not an op that ran.
  const deriveKey = viewerKeyDeriver({
    appId: app.appBlockId,
    ns: PUBLISHED_NS,
    collection: input.to,
    mode: 'parent+viewer',
  });
  const data = input.data ?? {};
  return audited(
    {
      app,
      action: 'markMigration',
      actorUserId: input.actorUserId,
      reason: input.reason,
      detail: `migrate mark ${input.mark} on ${input.from} to viewer-keyed ${input.to} in ${app.slug}`,
      before: {
        from: input.from,
        mark: input.mark,
        to: input.to,
        data,
        keyMapEntries: input.keyMap ? Object.keys(input.keyMap).length : 0,
      },
    },
    async () => {
      const frozen = await store.freezeMarks(app.appBlockId, {
        from: input.from,
        mark: input.mark,
        target,
        data,
        keyMap: input.keyMap,
        actorUid: input.actorUserId,
      });
      const copy = await store.copyMarksToDocs(app.appBlockId, {
        from: input.from,
        mark: input.mark,
        target,
        deriveKey,
        actorUid: input.actorUserId,
      });
      const verify = await store.verifyMarkMigration(app.appBlockId, {
        from: input.from,
        mark: input.mark,
        deriveKey,
        actorUid: input.actorUserId,
      });
      return { dryRun: false as const, created: frozen.created, check: frozen.check, copy, verify };
    }
  );
}

/**
 * The ROLLBACK of a mark migration, valid only before its target's switch opens: purge every
 * document of the target through the moderator delete path (dumped first) and mark the run
 * `rolled_back`, which lifts the freeze. The app's revert to its previous approved version is the
 * moderator's own step.
 */
export async function rollbackMarkMigration(
  input: { actorUserId: number; appBlockId: string; to: string; reason: string },
  deps: Deps = {}
): Promise<PurgeCollectionResult & { auditEventId: string }> {
  const store = deps.store ?? getDocStoreMaintenance();
  const app = await loadApp(input.appBlockId);
  const open = await isViewerKeyedOpen(prodCtx(app), input.to);
  const declared = await declaredCollection(app, input.to);
  return audited(
    {
      app,
      action: 'collectionPurge',
      actorUserId: input.actorUserId,
      reason: input.reason,
      detail: `roll back the mark migration into ${input.to} in ${app.slug}`,
      before: { collection: input.to, mode: 'rollback', targetOpen: open },
    },
    () =>
      store.purgeCollection(app.appBlockId, {
        collection: input.to,
        declared,
        mode: 'rollback',
        openTargets: new Set(open ? [input.to] : []),
        actorUid: input.actorUserId,
        reason: input.reason,
      })
  );
}

/**
 * The PER-COLLECTION PURGE of rollout step 4 (a counter collection's documents, once its marks are
 * migrated): every document of `collection` in the app's production namespace, dumped first, under
 * the gates `purgeCollection` in the store checks: no counter declared by the enforced manifest
 * (`$inc` refused), every mark on it migrated, verified and its target open, no open report.
 */
export async function purgeStorageCollection(
  input: { actorUserId: number; appBlockId: string; collection: string; reason: string },
  deps: Deps = {}
): Promise<PurgeCollectionResult & { auditEventId: string }> {
  const store = deps.store ?? getDocStoreMaintenance();
  const app = await loadApp(input.appBlockId);
  const declared = await declaredCollection(app, input.collection);
  const runs = await store.listMaintRuns(app.appBlockId);
  const targets = [
    ...new Set(
      runs
        .filter((r) => r.kind === 'mark_migration' && r.collection === input.collection)
        .map((r) => String(r.params.to))
    ),
  ].sort();
  const openTargets = new Set<string>();
  for (const t of targets) {
    if (await isViewerKeyedOpen(prodCtx(app), t)) openTargets.add(t);
  }
  return audited(
    {
      app,
      action: 'collectionPurge',
      actorUserId: input.actorUserId,
      reason: input.reason,
      detail: `purge collection ${input.collection} in ${app.slug}`,
      before: {
        collection: input.collection,
        mode: 'purge',
        declared: declared !== null,
        counters: declared?.config.counters ?? [],
        openTargets: [...openTargets],
      },
    },
    () =>
      store.purgeCollection(app.appBlockId, {
        collection: input.collection,
        declared,
        mode: 'purge',
        openTargets,
        actorUid: input.actorUserId,
        reason: input.reason,
      })
  );
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
