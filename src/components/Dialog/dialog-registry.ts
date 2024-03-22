import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal')
);
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
export const openHiddenTagsModal = () => dialogStore.trigger({ component: HiddenTagsModal });
export const openSetBrowsingLevelModal = (props: { imageId: number; nsfwLevel: number }) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });
