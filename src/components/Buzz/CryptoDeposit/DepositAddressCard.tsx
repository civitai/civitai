import { trpc } from '~/utils/trpc';
import { DepositCardVariantC } from './variants/DepositCardVariantC';

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
  chain?: string;
  onCurrencySelect?: (code: string, chain: string) => void;
}) {
  const utils = trpc.useUtils();

  const {
    data: walletData,
    isLoading: loading,
    error,
    refetch,
  } = trpc.nowPayments.getDepositAddress.useQuery(
    { chain },
    {
      onSuccess: () => {
        utils.nowPayments.getDepositHistory.invalidate();
      },
    }
  );

  const depositAddress = walletData?.address ?? '';

  return (
    <DepositCardVariantC
      depositAddress={depositAddress}
      error={error}
      loading={loading}
      onRetry={() => refetch()}
      chain={chain}
      onCurrencySelect={onCurrencySelect}
    />
  );
}
