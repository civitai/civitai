import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
export const openHiddenTagsModal = () => dialogStore.trigger({ component: HiddenTagsModal });
