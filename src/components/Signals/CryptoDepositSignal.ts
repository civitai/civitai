import { useCallback } from 'react';
import { showNotification } from '@mantine/notifications';
import { SUPPORTED_CURRENCIES_STALE_TIME } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { RouterOutput } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type CryptoDepositSignalData = {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  outcomeAmount?: number;
};

type SupportedCurrencies = RouterOutput['nowPayments']['getSupportedCurrencies'];

/** Currency code → display name, e.g. `usdttrc20` → `USDT on Tron`. */
function buildCurrencyNames(currencies: SupportedCurrencies | undefined) {
  const lookup: Record<string, string> = {};
  for (const group of currencies ?? []) {
    for (const net of group.networks) {
      const ticker = (net.ticker ?? group.ticker).toUpperCase();
      const network =
        group.networks.length > 1 && net.network
          ? ` on ${getDisplayName(net.network.toLowerCase())}`
          : '';
      lookup[net.code.toLowerCase()] = `${ticker}${network}`;
    }
  }
  return lookup;
}

export const useCryptoDepositSignal = () => {
  const queryUtils = trpc.useUtils();

  // Fetched when a deposit signal arrives, not on mount: this hook is mounted on every signed-in
  // page load, the list only names the currency in a toast, and deposits are rare. `fetch` reuses
  // the list when the deposit UI has already loaded it.
  const currencyDisplayName = useCallback(
    async (code: string) => {
      const fallback = code.toUpperCase();
      try {
        const currencies = await queryUtils.nowPayments.getSupportedCurrencies.fetch(undefined, {
          staleTime: SUPPORTED_CURRENCIES_STALE_TIME,
        });
        return buildCurrencyNames(currencies)[code.toLowerCase()] ?? fallback;
      } catch {
        // A failed lookup costs the pretty name, never the notification.
        return fallback;
      }
    },
    [queryUtils]
  );

  const onDepositUpdate = useCallback(
    async (data: CryptoDepositSignalData) => {
      // Invalidate deposit history so the transaction list refreshes
      queryUtils.nowPayments.getDepositHistory.invalidate();

      if (data.status === 'finished') {
        // The balance changed; refresh it without waiting on the currency name.
        queryUtils.buzz.getBuzzAccount.invalidate();

        const currencyDisplay = await currencyDisplayName(data.currency);
        const buzzAmount = data.outcomeAmount ? Math.floor(data.outcomeAmount * 1000) : null;
        showNotification({
          title: 'Crypto Deposit Complete',
          message: buzzAmount
            ? `You received ${buzzAmount.toLocaleString()} Buzz from your ${currencyDisplay} deposit.`
            : `Your ${currencyDisplay} deposit has been processed.`,
          color: 'green',
        });
      } else if (data.status === 'confirming') {
        const currencyDisplay = await currencyDisplayName(data.currency);
        showNotification({
          title: 'Crypto Deposit Detected',
          message: `Your ${currencyDisplay} deposit is being confirmed on-chain.`,
          color: 'blue',
        });
      }
    },
    [queryUtils, currencyDisplayName]
  );

  useSignalConnection(SignalMessages.CryptoDepositUpdate, onDepositUpdate);
};
