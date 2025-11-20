import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const ReadOnlyModal = dynamic(() => import('~/components/Modals/ReadOnlyModal'), {
  ssr: false,
});

export function openReadOnlyModal() {
  dialogStore.trigger({ component: ReadOnlyModal });
}
