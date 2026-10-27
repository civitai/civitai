import { ActionIcon, Tooltip } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import clsx from 'clsx';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReportEntity } from '~/shared/utils/report-helpers';

export function JudgeReportButton({
  imageId,
  side,
  className,
}: {
  imageId: number;
  side: string;
  className?: string;
}) {
  return (
    // data-judge-chrome keeps Space on this button from skipping the pair; the stops keep a click
    // from reaching the card's vote handler.
    <div
      data-judge-chrome
      data-testid="judge-report"
      data-side={side}
      className={clsx('rounded-full', className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Tooltip label="Report" withinPortal>
        <LoginRedirect reason="report-content">
          <ActionIcon
            className="bg-black/60 hover:bg-black/80"
            size="lg"
            radius="xl"
            variant="filled"
            color="dark"
            aria-label="Report"
            onClick={() => openReportModal({ entityType: ReportEntity.Image, entityId: imageId })}
          >
            <IconFlag size={18} />
          </ActionIcon>
        </LoginRedirect>
      </Tooltip>
    </div>
  );
}
