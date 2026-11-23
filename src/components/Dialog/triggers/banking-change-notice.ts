import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const BankingChangeNoticeModal = dynamic(
  () => import('~/components/Buzz/CreatorProgramV2/BankingChangeNoticeModal')
);

export const openBankingChangeNotice = () =>
  dialogStore.trigger({ component: BankingChangeNoticeModal, id: 'banking-change-notice' });
