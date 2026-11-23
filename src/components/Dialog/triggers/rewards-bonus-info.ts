import { openDialog } from '~/components/Dialog/openDialog';

export const openRewardsBonusInfo = () =>
  openDialog(
    () => import('~/components/Buzz/RewardsBonusInfoModal'),
    {},
    {
      id: 'rewards-bonus-info',
    }
  );
