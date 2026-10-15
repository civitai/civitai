import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

const createReport = vi.fn();
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createReport,
}));

const { createReportHandler } = await import('~/server/controllers/report.controller');
const { createReportOutputSchema } = await import('~/server/schema/report.schema');

/** A stored report row, with more fields than the client needs. */
const storedReport = {
  id: 74,
  status: ReportStatus.Pending,
  userId: 41,
  reason: ReportReason.TOSViolation,
  alsoReportedBy: [41, 52],
  details: { comment: 'first' },
  internalNotes: 'note',
  statusSetBy: 9,
  statusSetAt: new Date(),
  previouslyReviewedCount: 1,
  createdAt: new Date(),
};

const call = () =>
  createReportHandler({
    input: {
      type: ReportEntity.Crucible,
      id: 17,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Spam', comment: 'second' },
    } as never,
    ctx: { user: { id: 52, isModerator: false }, track: { report: vi.fn() } } as never,
  });

beforeEach(() => vi.clearAllMocks());

describe('report.create response', () => {
  it('returns only the report id and status', async () => {
    createReport.mockResolvedValue(storedReport);
    expect(await call()).toStrictEqual({ id: 74, status: ReportStatus.Pending });
  });

  it('returns null when nothing was written', async () => {
    createReport.mockResolvedValue(null);
    expect(await call()).toBeNull();
  });

  // The procedure's output schema, so a handler change that returns the stored row is cut back.
  it('strips anything beyond id and status at the procedure', () => {
    expect(createReportOutputSchema.parse(storedReport)).toStrictEqual({
      id: 74,
      status: ReportStatus.Pending,
    });
  });

  it('is the output schema the procedure validates against', async () => {
    const { reportRouter } = await import('~/server/routers/report.router');
    const procedure = reportRouter._def.procedures.create as unknown as {
      _def: { output?: unknown };
    };
    expect(procedure._def.output).toBe(createReportOutputSchema);
  });
});
