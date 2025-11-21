import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ReportModalProps } from '~/components/Modals/ReportModal';

const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'), {
  ssr: false,
});

export function openReportModal(props: ReportModalProps) {
  dialogStore.trigger({ component: ReportModal, props });
}
