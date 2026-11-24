import { openDialog } from '~/components/Dialog/openDialog';

export const openBankingChangeNotice = () =>
  openDialog(
    () => import('~/components/Buzz/CreatorProgramV2/BankingChangeNoticeModal'),
    undefined,
    {
      id: 'banking-change-notice',
    }
  );
