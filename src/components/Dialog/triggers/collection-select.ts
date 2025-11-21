import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';

const CollectionSelectModal = dynamic(
  () => import('~/components/CollectionSelectModal/CollectionSelectModal'),
  { ssr: false }
);

export function openCollectionSelectModal(props: CollectionSelectModalProps) {
  dialogStore.trigger({ component: CollectionSelectModal, props });
}
