import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { findReportToFoldInto } from '~/server/services/report.service';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

// CommentV3Report keys its comment as `commentId`, not `commentV3Id`: the generic field name would
// make every CommentV3 report's duplicate lookup fail. It also finds a report the mirror copied from
// CommentV2Report, so a new report folds into the old one rather than listing the comment twice.
describe('folding a new CommentV3 report into an existing one', () => {
  it('looks the report up by the comment through CommentV3Report.commentId', async () => {
    dbMock.dbWrite.report.findFirst.mockResolvedValueOnce(null);
    await findReportToFoldInto({
      reportType: ReportEntity.CommentV3,
      entityReportId: 41,
      reason: ReportReason.TOSViolation,
    });
    expect(dbMock.dbWrite.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ commentV3: { commentId: 41 } }),
      })
    );
  });
});
