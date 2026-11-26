import { openDialog } from '~/components/Dialog/openDialog';
import type { ReportModalProps } from '~/components/Modals/ReportModal';

export function openReportModal(props: ReportModalProps) {
  openDialog(() => import('~/components/Modals/ReportModal'), props);
}
