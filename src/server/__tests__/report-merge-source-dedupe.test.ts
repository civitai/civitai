import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MERGE_PERMISSION_REPORT_REASON } from '@civitai/shared/merge-permission';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    model: { update: vi.fn() },
  })
);

// Distinct so a value reaching the wrong place cannot pass by colliding with the right one.
const MERGE_MODEL = 71;
const REPORTER = 82;
const SOURCE_ONE = 115;
const SOURCE_TWO = 126;

const reportFindFirst = dbMock.dbWrite.report.findFirst;
const reportCreate = vi.fn();

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const mergeReport = (sourceModelId: number) => ({
  userId: REPORTER,
  id: MERGE_MODEL,
  type: ReportEntity.Model,
  reason: ReportReason.AdminAttention,
  details: { reason: MERGE_PERMISSION_REPORT_REASON, sourceModelId },
});

beforeEach(() => {
  vi.clearAllMocks();
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 137, details: {} });
});

describe('a merge-permission report is deduped by source model', () => {
  it('looks only for an earlier merge report naming the same source model', async () => {
    await createReport(mergeReport(SOURCE_TWO));

    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.AND).toEqual([
      { details: { path: ['reason'], equals: MERGE_PERMISSION_REPORT_REASON } },
      { details: { path: ['sourceModelId'], equals: SOURCE_TWO } },
    ]);
    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({ sourceModelId: SOURCE_TWO });
  });

  it('control: any other AdminAttention report on a model dedupes as before', async () => {
    await createReport({
      ...mergeReport(SOURCE_ONE),
      details: { reason: 'Other concern' },
    });

    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.AND).toBeUndefined();
  });
});

describe('the AdminAttention details schema', () => {
  it('requires the source model for a merge-permission report', () => {
    const result = reportAdminAttentionDetailsSchema.safeParse({
      reason: MERGE_PERMISSION_REPORT_REASON,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['sourceModelId']);
  });

  it('takes a model link and stores its id', () => {
    expect(
      reportAdminAttentionDetailsSchema.parse({
        reason: MERGE_PERMISSION_REPORT_REASON,
        sourceModelId: `https://civitai.com/models/${SOURCE_ONE}/some-lora?modelVersionId=9`,
      }).sourceModelId
    ).toBe(SOURCE_ONE);
  });

  it('control: other reasons need no source model', () => {
    expect(reportAdminAttentionDetailsSchema.safeParse({ reason: 'Other concern' }).success).toBe(
      true
    );
  });
});
