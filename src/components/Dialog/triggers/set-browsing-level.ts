import type { SetBrowsingLevelModalProps } from '~/components/BrowsingLevel/SetBrowsingLevelModal';
import { openDialog } from '~/components/Dialog/openDialog';

export const openSetBrowsingLevelModal = (props: SetBrowsingLevelModalProps) =>
  openDialog(() => import('~/components/BrowsingLevel/SetBrowsingLevelModal'), props);
