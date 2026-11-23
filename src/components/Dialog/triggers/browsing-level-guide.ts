import { openDialog } from '~/components/Dialog/openDialog';

export const openBrowsingLevelGuide = () =>
  openDialog(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
