import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'), {
  ssr: false,
});

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
