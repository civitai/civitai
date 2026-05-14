import {
  deleteLabelVerdictSchema,
  exportRowsSchema,
  focusedItemContentSchema,
  focusedRunSchema,
  getScanDetailSchema,
  getWorkflowRawSchema,
  listScansSchema,
  upsertLabelVerdictSchema,
} from '~/server/schema/scanner-review.schema';
import {
  deleteLabelVerdict,
  focusedItemContent,
  focusedRun,
  getScanDetail,
  listScans,
  upsertLabelVerdict,
} from '~/server/services/scanner-review.service';
import { getWorkflowRaw } from '~/server/services/scanner-content.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const scannerReviewRouter = router({
  list: moderatorProcedure
    .input(listScansSchema)
    .query(({ input, ctx }) => listScans(input, ctx.user.id)),

  detail: moderatorProcedure.input(getScanDetailSchema).query(({ input }) => getScanDetail(input)),

  upsertVerdict: moderatorProcedure
    .input(upsertLabelVerdictSchema)
    .mutation(({ input, ctx }) => upsertLabelVerdict({ ...input, userId: ctx.user.id })),

  deleteVerdict: moderatorProcedure
    .input(deleteLabelVerdictSchema)
    .mutation(({ input, ctx }) => deleteLabelVerdict({ ...input, userId: ctx.user.id })),

  // Returns up to 50k rows for client-side CSV stringify + download.
  exportRows: moderatorProcedure
    .input(exportRowsSchema)
    .query(({ input, ctx }) => listScans(input, ctx.user.id)),

  // Focused-review run: audit rows for a (scanner, label) pair, excluding
  // the mod's prior verdicts. Content is resolved separately via
  // `focusedItemContent` so the queue can paint immediately.
  focusedRun: moderatorProcedure
    .input(focusedRunSchema)
    .query(({ input, ctx }) => focusedRun({ ...input, userId: ctx.user.id })),

  // Single-item content resolver. Called per-item as the mod cursors through
  // the focused run; the client prefetches the next N items via React Query
  // so cursor advances feel instant.
  focusedItemContent: moderatorProcedure
    .input(focusedItemContentSchema)
    .query(({ input }) => focusedItemContent(input)),

  // Raw workflow JSON for moderator inspection — used by the focused-review
  // "View raw workflow" drawer.
  getWorkflowRaw: moderatorProcedure
    .input(getWorkflowRawSchema)
    .query(({ input }) => getWorkflowRaw(input.workflowId)),
});
