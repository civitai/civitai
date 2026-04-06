import { useCallback, useMemo } from 'react';
import { showNotification } from '@mantine/notifications';
import { useSupportedCurrencies } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
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

      // Show a toast notification when a deposit completes
      if (data.status === 'finished') {
        const buzzAmount = data.outcomeAmount ? Math.floor(data.outcomeAmount * 1000) : null;
        showNotification({
          title: 'Crypto Deposit Complete',
          message: buzzAmount
            ? `You received ${buzzAmount.toLocaleString()} Buzz from your ${currencyDisplay} deposit.`
            : `Your ${currencyDisplay} deposit has been processed.`,
          color: 'green',
        });

        // Also invalidate buzz account since balance changed
        queryUtils.buzz.getBuzzAccount.invalidate();
      } else if (data.status === 'confirming') {
        showNotification({
          title: 'Crypto Deposit Detected',
          message: `Your ${currencyDisplay} deposit is being confirmed on-chain.`,
          color: 'blue',
        });
      }
    },
    [queryUtils, currencyNames]
  );

  useSignalConnection(SignalMessages.CryptoDepositUpdate, onDepositUpdate);
};
