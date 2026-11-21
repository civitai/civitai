import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const BulkBonusInfoModal = dynamic(
  () => import('~/components/Buzz/CryptoDeposit/BulkBonusInfoModal')
);

export const openBulkBonusInfo = () =>
  dialogStore.trigger({ component: BulkBonusInfoModal, id: 'bulk-bonus-info' });
