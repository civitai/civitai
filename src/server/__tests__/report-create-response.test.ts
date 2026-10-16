import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

const { createReport, getAppealCount } = vi.hoisted(() => ({
  createReport: vi.fn(),
  getAppealCount: vi.fn(async () => 0),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createReport,
  getAppealCount,
}));

const { createReportHandler, getRecentAppealsHandler } = await import(
  '~/server/controllers/report.controller'
);
const { createReportOutputSchema, getRecentAppealsSchema } = await import(
  '~/server/schema/report.schema'
);

/** A stored report row, with more fields than the client needs. */
const storedReport = {
  id: 74,
  status: ReportStatus.Actioned,
  userId: 41,
  reason: ReportReason.TOSViolation,
  alsoReportedBy: [41, 52],
  details: { comment: 'first' },
  internalNotes: 'note',
  statusSetBy: 9,
};

const CALLER = 52;
const track = { report: vi.fn() };
const ctx = { user: { id: CALLER, isModerator: false }, track } as never;

beforeEach(() => vi.clearAllMocks());

describe('report.create response', () => {
  const call = () =>
    createReportHandler({
      input: {
        type: ReportEntity.Crucible,
        id: 17,
        reason: ReportReason.TOSViolation,
        details: { violation: 'Spam', comment: 'second' },
      } as never,
      ctx,
    });

  it('returns no data, and still tracks the report with its status', async () => {
    createReport.mockResolvedValue(storedReport);
    expect(await call()).toBeNull();
    expect(track.report).toHaveBeenCalledWith(
      expect.objectContaining({ status: ReportStatus.Actioned })
    );
  });

  it('is held to no data at the procedure', async () => {
    expect(createReportOutputSchema.safeParse(storedReport).success).toBe(false);
    expect(createReportOutputSchema.parse(null)).toBeNull();
    const { reportRouter } = await import('~/server/routers/report.router');
    const procedure = reportRouter._def.procedures.create as unknown as {
      _def: { output?: unknown };
    };
    expect(procedure._def.output).toBe(createReportOutputSchema);
  });
});

describe('report.getRecentAppeals', () => {
  it("counts the caller's own appeals, whatever userId is sent", async () => {
    const input = getRecentAppealsSchema.parse({ userId: 99 });
    await getRecentAppealsHandler({ input, ctx });
    expect(getAppealCount).toHaveBeenCalledWith(expect.objectContaining({ userId: CALLER }));
  });

  // Each half on its own, so reverting either one alone is caught.
  it('takes no userId in its input', () => {
    expect(getRecentAppealsSchema.parse({ userId: 99 })).not.toHaveProperty('userId');
  });

  it('ignores a userId that reaches the handler', async () => {
    await getRecentAppealsHandler({ input: { userId: 99 } as never, ctx });
    expect(getAppealCount).toHaveBeenCalledTimes(1);
    expect(getAppealCount).toHaveBeenCalledWith(expect.objectContaining({ userId: CALLER }));
  });
});
