// App Blocks — MODERATOR surface for the DOCUMENT STORE (`trpc.apps.mod.docStore.*`):
// the cross-app queue of reported shared documents, a read of one, hide / unhide and
// hard delete. The service (`doc-store-moderation.service.ts`) explains how a
// cross-app action runs under the store's row-level security and how each action is
// audited.
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
import {
  DocStoreModerationError,
  deleteModeratedDoc,
  dismissModeratedDocReports,
  getModeratedDoc,
  listReportedDocs,
  setModeratedDocHidden,
} from '~/server/services/apps/doc-store-moderation.service';
import { DOC_STORE_BOUNDS, isDocStoreError } from '~/server/services/apps/doc-store.types';

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
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'storage is busy; retry',
        cause: err,
      });
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
});
