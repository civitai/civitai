import { Button } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReportEntity } from '~/shared/utils/report-helpers';

/** Opens the site's report modal on an offering. A seller never sees it on their own. */
export function ReportServiceButton({ offeringId }: { offeringId: number }) {
  return (
    <LoginRedirect reason="report-content">
      <Button
        variant="subtle"
        color="gray"
        size="compact-xs"
        leftSection={<IconFlag size={14} />}
        onClick={() =>
          openReportModal({ entityType: ReportEntity.ServiceOffering, entityId: offeringId })
        }
      >
        Report
      </Button>
    </LoginRedirect>
  );
}
