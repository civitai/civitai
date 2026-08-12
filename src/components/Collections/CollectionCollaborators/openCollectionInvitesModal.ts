import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const CollectionInvitesModal = dynamic(
  () => import('~/components/Collections/CollectionCollaborators/CollectionInvitesModal')
);

export function openCollectionInvitesModal() {
  dialogStore.trigger({ component: CollectionInvitesModal });
}
