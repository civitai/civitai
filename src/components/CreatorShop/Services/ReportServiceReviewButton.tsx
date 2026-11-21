import { ActionIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconFlag } from '@tabler/icons-react';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReportEntity } from '~/shared/utils/report-helpers';

/** Opens the site's report modal on one buyer review: its text and its images. */
export function ReportServiceReviewButton({ reviewId }: { reviewId: number }) {
  return (
    <LoginRedirect reason="report-content">
      <Tooltip label="Report this review" withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Report this review"
          onClick={() =>
            openReportModal({ entityType: ReportEntity.ServiceDealReview, entityId: reviewId })
          }
        >
          <IconFlag size={14} />
        </ActionIcon>
      </Tooltip>
    </LoginRedirect>
  );
}
