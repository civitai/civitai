import {
  createCsamReportHandler,
  createExternalCsamReportHandler,
} from '~/server/controllers/csam.controller';
import { paginationSchema } from '~/server/schema/base.schema';
import {
  createCsamReportSchema,
  createExternalCsamReportSchema,
  getCsamContextCandidatesSchema,
  getCsamSupplementalPreviewSchema,
  getImageResourcesSchema,
  approveGeneratorEvidenceSchema,
  clearUnconfirmedOpenSchema,
  excludeGeneratorEvidenceFileSchema,
  generatorEvidenceFileSchema,
  generatorEvidenceUserSchema,
  generatorEvidenceWorkflowsSchema,
  preserveGeneratorEvidenceSchema,
} from '~/server/schema/csam.schema';
import {
  approveGeneratorEvidenceReport,
  excludeGeneratorEvidenceFile,
  getEvidenceTriggers,
  getEvidenceWorkflows,
  getGeneratorEvidenceReport,
  preserveGeneratorEvidence,
  recopyGeneratorEvidenceFile,
} from '~/server/services/generator-evidence/generator-evidence.service';
import { getCsamSupplementalPreview } from '~/server/services/csam-supplemental.service';
import { getCsamContextCandidates } from '~/server/services/csam-context-text';
import { clearUnconfirmedOpens } from '~/server/services/csam-unconfirmed-open';
import {
  getCsamReportStats,
  getCsamReportsPaged,
  getImageResources,
} from '~/server/services/csam.service';
import { isFlagProtected, moderatorProcedure, router } from '~/server/trpc';

const csamProcedure = moderatorProcedure.use(isFlagProtected('csamReports'));
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const csamRouter = router({
  getImageResources: moderatorProcedure
    .input(getImageResourcesSchema)
    .query(({ input }) => getImageResources(input)),
  getContextCandidates: moderatorProcedure
    .input(getCsamContextCandidatesSchema)
    .query(({ input }) => getCsamContextCandidates(input)),
  createReport: moderatorProcedure.input(createCsamReportSchema).mutation(createCsamReportHandler),
  getSupplementalPreview: moderatorProcedure
    .input(getCsamSupplementalPreviewSchema)
    .query(({ input, ctx }) => getCsamSupplementalPreview({ ...input, reportedById: ctx.user.id })),
  createExternalReport: moderatorProcedure
    .input(createExternalCsamReportSchema)
    .mutation(createExternalCsamReportHandler),
  getCsamReports: csamProcedure
    .input(paginationSchema)
    .query(({ input }) => getCsamReportsPaged(input)),
  getCsamReportsStats: csamProcedure.query(() => getCsamReportStats()),
  getGeneratorEvidenceTriggers: csamProcedure
    .input(generatorEvidenceUserSchema)
    .query(({ input }) => getEvidenceTriggers(input.userId)),
  getGeneratorEvidenceWorkflows: csamProcedure
    .input(generatorEvidenceWorkflowsSchema)
    .query(({ input }) => getEvidenceWorkflows(input.userId, input.cursor)),
  getGeneratorEvidenceReport: csamProcedure
    .input(generatorEvidenceUserSchema)
    .query(({ input, ctx }) => getGeneratorEvidenceReport(input.userId, ctx.user.id)),
  preserveGeneratorEvidence: csamProcedure
    .input(preserveGeneratorEvidenceSchema)
    .mutation(({ input, ctx }) =>
      preserveGeneratorEvidence({ ...input, moderatorId: ctx.user.id })
    ),
  approveGeneratorEvidence: csamProcedure
    .input(approveGeneratorEvidenceSchema)
    .mutation(({ input, ctx }) =>
      approveGeneratorEvidenceReport({ ...input, moderatorId: ctx.user.id })
    ),
  recopyGeneratorEvidenceFile: csamProcedure
    .input(generatorEvidenceFileSchema)
    .mutation(({ input, ctx }) =>
      recopyGeneratorEvidenceFile({ ...input, moderatorId: ctx.user.id })
    ),
  excludeGeneratorEvidenceFile: csamProcedure
    .input(excludeGeneratorEvidenceFileSchema)
    .mutation(({ input, ctx }) =>
      excludeGeneratorEvidenceFile({ ...input, moderatorId: ctx.user.id })
    ),
  clearUnconfirmedOpen: csamProcedure
    .input(clearUnconfirmedOpenSchema)
    .mutation(({ input, ctx }) => clearUnconfirmedOpens({ ...input, moderatorId: ctx.user.id })),
});
