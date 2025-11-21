import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { SetBrowsingLevelModalProps } from '~/components/BrowsingLevel/SetBrowsingLevelModal';

const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal'),
  { ssr: false }
);

// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: SetBrowsingLevelModalProps) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });
