import { openDialog } from '~/components/Dialog/openDialog';

export const openBulkBonusInfo = () =>
  openDialog(
    () => import('~/components/Buzz/CryptoDeposit/BulkBonusInfoModal'),
    {},
    {
      id: 'bulk-bonus-info',
    }
  );
