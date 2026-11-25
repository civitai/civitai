// App Blocks — MODERATOR surface for the DOCUMENT STORE (`trpc.apps.mod.docStore.*`):
// the cross-app queue of reported shared documents, a read of one, hide / unhide and
// hard delete. The service (`doc-store-moderation.service.ts`) explains how a
// cross-app action runs under the store's row-level security and how each action is
// audited.
//
// `maintenance.*`: read-only views of the run records the rollout step 4 data migration left
// (`docs/app-storage-generic-core.md`): the runs, and one purge's dump while it is retained. The
// tooling that wrote them is removed. No UI calls them; `storage-mark-migration.service.ts`.
//
// Session `moderatorProcedure`, NOT block-token reachable: a block token is not a
// session, and the store's block-token routes (`doc-store-api.ts`) never call the
// moderation operations.
//
// 🔴 DELIBERATELY NOT BEHIND `enforceAppBlocksFlag`, like its siblings
// `apps.mod.purgeSharedRow` and `apps.mod.userStorage.*`: a takedown has to work while
// the feature kill-switch is dark.
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  OFFSITE_MOD_REASON_MAX,
  OFFSITE_MOD_REASON_MIN,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { moderatorProcedure, router } from '~/server/trpc';
import { isUlidShaped } from '~/server/utils/app-block-ids';
import { retryAfterSecondsOf, throwAppRateLimited } from '~/server/utils/app-rate-limit';
import {
  DocStoreModerationError,
  deleteModeratedDoc,
  dismissModeratedDocReports,
  getModeratedDoc,
  listReportedDocs,
  setModeratedDocHidden,
} from '~/server/services/apps/doc-store-moderation.service';
import {
  DOC_STORE_BOUNDS,
  DocStoreMigrationPendingError,
  isDocStoreError,
} from '~/server/services/apps/doc-store.types';
import {
  StorageMaintenanceError,
  storageMaintenanceStatus,
  storagePurgeDump,
} from '~/server/services/apps/storage-mark-migration.service';

const appBlockIdInput = z.string().min(1).max(64);
const collectionInput = z.string().regex(DOC_STORE_BOUNDS.collectionName);
const keyInput = z.string().regex(DOC_STORE_BOUNDS.key);
/** The listing takedown verbs' floor and ceiling, trimmed like the per-user storage purge. */
const reasonInput = z.string().trim().min(OFFSITE_MOD_REASON_MIN).max(OFFSITE_MOD_REASON_MAX);
/** The revision the moderator saw; the action is refused (CONFLICT) if the document changed. */
const revisionInput = z.number().int().nonnegative().optional();
const target = { appBlockId: appBlockIdInput, collection: collectionInput, key: keyInput };

/** Map service and store refusals to tRPC codes. Messages are fixed; the original is the `cause`. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DocStoreModerationError) {
      if (err.kind === 'version_conflict') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'document changed since it was read; reload and retry',
          cause: err,
        });
      }
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: err.kind === 'app_not_found' ? 'app block not found' : 'document not found',
        cause: err,
      });
    }
    if (isDocStoreError(err, 'invalid_request')) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid request', cause: err });
    }
    if (isDocStoreError(err, 'rate_limited')) {
      const retryAfter = err.details?.retryAfter;
      throwAppRateLimited(
        'apps.doc-store',
        retryAfterSecondsOf(retryAfter, 1),
        'storage is busy; retry'
      );
    }
    if (isDocStoreError(err, 'storage_disabled')) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'document storage is not available',
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * The maintenance ops' refusals carry their reason to the moderator: the message names what to do
 * next (`invalid_request` messages are the store's own fixed strings, naming collections only).
 */
async function mappedMaintenance<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageMaintenanceError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found', cause: err });
    }
    if (err instanceof DocStoreMigrationPendingError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `the datastore migration ${err.migration} is not applied yet`,
        cause: err,
      });
    }
    if (isDocStoreError(err, 'invalid_request')) {
      const reason = err.details?.reason;
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: typeof reason === 'string' ? `${err.message} (${reason})` : err.message,
        cause: err,
      });
    }
    if (isDocStoreError(err, 'service_unavailable') && err.details?.reason) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `storage is not ready for this operation (${String(err.details.reason)})`,
        cause: err,
      });
    }
    return mapped(() => Promise.reject(err));
  }
}

const maintenanceRouter = router({
  /** Every mark migration and purge recorded for the app's production namespace (read only). */
  status: moderatorProcedure
    .input(z.object({ appBlockId: appBlockIdInput }))
    .query(({ input }) => mappedMaintenance(() => storageMaintenanceStatus(input))),

  /** Every row one purge deleted. */
  purgeDump: moderatorProcedure
    .input(
      z.object({
        appBlockId: appBlockIdInput,
        collection: collectionInput,
        runId: z.string().refine(isUlidShaped, 'not a run id'),
      })
    )
    .query(({ input }) => mappedMaintenance(() => storagePurgeDump(input))),
});

export const appsModDocStoreRouter = router({
  /** Reported shared documents across apps, most reported first; capped, not paged (`truncated`). */
  listReported: moderatorProcedure
    .input(
      z.object({
        status: z.enum(['open', 'hidden', 'all']).default('open'),
      })
    )
    .query(({ input }) => mapped(() => listReportedDocs(input))),

  /** One shared document with its data. */
  get: moderatorProcedure
    .input(z.object(target))
    .query(({ input }) => mapped(() => getModeratedDoc(input))),

  /** Hide (reads as not found to the app) or unhide. Reversible. */
  setHidden: moderatorProcedure
    .input(
      z.object({ ...target, hidden: z.boolean(), reason: reasonInput, revision: revisionInput })
    )
    .mutation(({ ctx, input }) =>
      mapped(() => setModeratedDocHidden({ ...input, actorUserId: ctx.user.id }))
    ),

  /** Dismiss the open reports on a document reviewed and kept. Reports made later re-open it. */
  dismissReports: moderatorProcedure
    .input(z.object({ ...target, reason: reasonInput, revision: revisionInput }))
    .mutation(({ ctx, input }) =>
      mapped(() => dismissModeratedDocReports({ ...input, actorUserId: ctx.user.id }))
    ),

  /** Hard delete, with its tallies, marks and index rows; refunds usage. Irreversible. */
  delete: moderatorProcedure
    .input(z.object({ ...target, reason: reasonInput, revision: revisionInput }))
    .mutation(({ ctx, input }) =>
      mapped(() => deleteModeratedDoc({ ...input, actorUserId: ctx.user.id }))
    ),

  /** The data-migration run records, read only (`storage-mark-migration.service.ts`). */
  maintenance: maintenanceRouter,
});
