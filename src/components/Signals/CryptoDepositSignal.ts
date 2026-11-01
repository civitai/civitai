import { useCallback, useMemo } from 'react';
import { showNotification } from '@mantine/notifications';
import { useSupportedCurrencies } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
import { cryptoDepositToast } from '~/components/Signals/crypto-deposit-toast';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type CryptoDepositSignalData = {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  outcomeAmount?: number;
};

export const useCryptoDepositSignal = () => {
  const queryUtils = trpc.useUtils();
  const { data: currencies } = useSupportedCurrencies();

  // Build currency code → display name lookup
  const currencyNames = useMemo(() => {
    if (!currencies) return {};
    const lookup: Record<string, string> = {};
    for (const group of currencies) {
      for (const net of group.networks) {
        const ticker = (net.ticker ?? group.ticker).toUpperCase();
        const network = group.networks.length > 1 && net.network
          ? ` on ${getDisplayName(net.network.toLowerCase())}`
          : '';
        lookup[net.code.toLowerCase()] = `${ticker}${network}`;
      }
    }
    return lookup;
  }, [currencies]);

  const onDepositUpdate = useCallback(
    (data: CryptoDepositSignalData) => {
      // Invalidate deposit history so the transaction list refreshes
      queryUtils.nowPayments.getDepositHistory.invalidate();

      const currencyDisplay = currencyNames[data.currency?.toLowerCase()] ?? data.currency.toUpperCase();

      const toast = cryptoDepositToast(data.status, currencyDisplay, data.outcomeAmount);
      if (toast) showNotification(toast);
      if (data.status === 'finished') queryUtils.buzz.getBuzzAccount.invalidate();
    },
    [queryUtils, currencyNames]
  );

  useSignalConnection(SignalMessages.CryptoDepositUpdate, onDepositUpdate);
};
