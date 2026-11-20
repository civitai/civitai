import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const RewardsBonusInfoModal = dynamic(() => import('~/components/Buzz/RewardsBonusInfoModal'));

export const openRewardsBonusInfo = () =>
  dialogStore.trigger({ component: RewardsBonusInfoModal, id: 'rewards-bonus-info' });
