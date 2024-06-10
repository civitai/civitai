import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const SetNsfwLevelModal = dynamic(() => import('~/components/BrowsingLevel/SetNsfwLevelModal'));
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
// TODO.Justin - allow image owners to request image rating change
export const openSetNsfwLevelModal = (props: { imageId: number; nsfwLevel: number }) =>
  dialogStore.trigger({ component: SetNsfwLevelModal, props });
export const openHiddenTagsModal = () =>
  dialogStore.trigger({ component: HiddenTagsModal, target: '#browsing-mode' });
