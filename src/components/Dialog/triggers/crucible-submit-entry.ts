import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { CrucibleSubmitEntryModalProps } from '~/components/Crucible/CrucibleSubmitEntryModal';

const CrucibleSubmitEntryModal = dynamic(
  () => import('~/components/Crucible/CrucibleSubmitEntryModal'),
  { ssr: false }
);

export function openCrucibleSubmitEntryModal(props: CrucibleSubmitEntryModalProps) {
  dialogStore.trigger({ component: CrucibleSubmitEntryModal, props });
}
