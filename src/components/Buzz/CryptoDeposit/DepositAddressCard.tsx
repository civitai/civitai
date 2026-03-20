import { useCallback } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GetDepositAddressInput } from '~/server/schema/nowpayments.schema';
import { trpc } from '~/utils/trpc';
import { DepositCardContent } from './DepositCardContent';

export type DepositCardProps = {
  depositAddress: string;
  error: { message: string } | null;
  loading: boolean;
  onRetry: () => void;
  chain: string;
  onCurrencySelect?: (code: string, chain: string) => void;
};

export function DepositAddressCard({
  chain = 'evm',
  onCurrencySelect,
}: {
  chain?: GetDepositAddressInput['chain'];
  onCurrencySelect?: (code: string, chain: string) => void;
}) {
  const currentUser = useCurrentUser();
  const {
    data: walletData,
    isLoading: loading,
    error,
    refetch,
  } = trpc.nowPayments.getDepositAddress.useQuery({ chain }, { enabled: !!currentUser });

  const depositAddress = walletData?.address ?? '';

  const handleRetry = useCallback(() => {
    refetch();
  }, [refetch]);

  return (
    <DepositCardContent
      depositAddress={depositAddress}
      error={error}
      loading={loading}
      onRetry={handleRetry}
      chain={chain}
      onCurrencySelect={onCurrencySelect}
    />
  );
}
