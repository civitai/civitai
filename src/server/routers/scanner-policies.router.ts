import {
  cancelRunInputSchema,
  deleteCandidateInputSchema,
  deleteExportInputSchema,
  deleteLabelInputSchema,
  getDownloadUrlInputSchema,
  getSystemPromptInputSchema,
  listCandidatesInputSchema,
  listExportsInputSchema,
  setActiveInputSchema,
  setSystemPromptInputSchema,
  startRunInputSchema,
  upsertCandidateInputSchema,
} from '~/server/schema/scanner-policies.schema';
import {
  deleteCandidate,
  deleteLabel,
  getExportById,
  getSystemPrompt,
  listCandidates,
  listExports,
  listLabels,
  markRunCancelled,
  setCandidateActive,
  setSystemPrompt,
  upsertCandidate,
} from '~/server/services/scanner-policies.service';
import { deleteExport } from '~/server/services/scanner-policies-dataset.service';
import { startRun } from '~/server/services/scanner-policies-test.service';
import { getGetUrlByKey } from '~/utils/s3-utils';
import { moderatorProcedure, router } from '~/server/trpc';
import { TRPCError } from '@trpc/server';

export const scannerPoliciesRouter = router({
  // ----- read -----
  listLabels: moderatorProcedure.query(() => listLabels()),

  listCandidates: moderatorProcedure
    .input(listCandidatesInputSchema)
    .query(({ input }) => listCandidates(input)),

  getSystemPrompt: moderatorProcedure
    .input(getSystemPromptInputSchema)
    .query(({ input }) => getSystemPrompt(input.mode)),

  listExports: moderatorProcedure
    .input(listExportsInputSchema)
    .query(({ input }) => listExports(input)),

  getDownloadUrl: moderatorProcedure
    .input(getDownloadUrlInputSchema)
    .query(async ({ input }) => {
      const record = await getExportById(input.exportId);
      if (!record) throw new TRPCError({ code: 'NOT_FOUND', message: 'Export not found' });
      const { url } = await getGetUrlByKey(record.s3Key, { fileName: record.filename });
      return { url, filename: record.filename };
    }),

  // ----- write -----
  upsertCandidate: moderatorProcedure
    .input(upsertCandidateInputSchema)
    .mutation(({ input, ctx }) => upsertCandidate(input, ctx.user.id)),

  setActive: moderatorProcedure
    .input(setActiveInputSchema)
    .mutation(({ input }) => setCandidateActive(input)),

  deleteCandidate: moderatorProcedure
    .input(deleteCandidateInputSchema)
    .mutation(({ input }) => deleteCandidate(input)),

  deleteLabel: moderatorProcedure
    .input(deleteLabelInputSchema)
    .mutation(({ input }) => deleteLabel(input)),

  setSystemPrompt: moderatorProcedure
    .input(setSystemPromptInputSchema)
    .mutation(({ input }) => setSystemPrompt(input)),

  cancelRun: moderatorProcedure
    .input(cancelRunInputSchema)
    .mutation(({ input }) => markRunCancelled(input.runId)),

  startRun: moderatorProcedure
    .input(startRunInputSchema)
    .mutation(({ input, ctx }) => startRun({ datasetId: input.datasetId, userId: ctx.user.id })),

  deleteExport: moderatorProcedure
    .input(deleteExportInputSchema)
    .mutation(({ input }) => deleteExport(input.exportId)),
});
