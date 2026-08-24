import { ExternalModerationType } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { findBlockedMessagePattern } from '~/server/services/blocklist.service';
import { createReport } from '~/server/services/report.service';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

/**
 * The `MessagePattern` blocklist, applied to comments. Chat throws on a match; a comment does not — a
 * hard error tells the author which words to change and hands a spam wave a free oracle, so the comment
 * is accepted and reported instead. Best-effort by construction: a comment that posted must not fail
 * afterwards because the report could not be written.
 */
export async function reportBlockedMessagePattern({
  type,
  entityId,
  userId,
  content,
  isModerator,
}: {
  type: 'Comment' | 'CommentV2';
  entityId: number;
  userId: number;
  content: string;
  isModerator?: boolean;
}): Promise<void> {
  if (isModerator) return;

  try {
    const pattern = await findBlockedMessagePattern(content);
    if (!pattern) return;

    // An edit re-runs this, and `createReport` skips its duplicate check for `Automated`, so without
    // this one comment edited five times is five rows in the queue.
    const existing = await dbRead.report.findFirst({
      where: {
        reason: ReportReason.Automated,
        status: ReportStatus.Pending,
        ...(type === 'Comment'
          ? { comment: { commentId: entityId } }
          : { commentV2: { commentV2Id: entityId } }),
      },
      select: { id: true },
    });
    if (existing) return;

    const report = await createReport({
      type: type === 'Comment' ? ReportEntity.Comment : ReportEntity.CommentV2,
      id: entityId,
      userId: -1,
      isModerator: true,
      reason: ReportReason.Automated,
      details: {
        externalType: ExternalModerationType.MessagePattern,
        entityId,
        userId,
        tags: [pattern],
      },
    });
    if (!report) return;

    // The matched text, so a moderator can judge the hit — the report row carries only which pattern fired.
    await dbWrite.reportAutomated.create({
      data: { reportId: report.id, metadata: { tags: [pattern], value: content } },
    });
  } catch (error) {
    logToAxiom({
      name: 'message-pattern-report',
      type: 'error',
      message: (error as Error).message,
      details: { type, entityId },
    }).catch(() => undefined);
  }
}
