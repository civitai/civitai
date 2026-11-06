import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * A chapter is one post, and taking a chapter down acts on that post, so its report is the post's
 * report. Moderators see the storyline around it in the post report queue.
 */
export function ReportChapterMenuItem({ postId }: { postId: number }) {
  return (
    <ReportMenuItem
      label="Report chapter"
      onReport={() => openReportModal({ entityType: ReportEntity.Post, entityId: postId })}
    />
  );
}
