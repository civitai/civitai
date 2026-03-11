import React, { useState } from 'react';
import { trpc } from '~/utils/trpc';
import { DepositCardVariantC } from './variants/DepositCardVariantC';

export type DepositCardProps = {
  depositAddress: string;
  error: { message: string } | null;
  loading: boolean;
  onRetry: () => void;
};

export function DepositAddressCard() {
  const utils = trpc.useUtils();

  const {
    mutate: createOrGetAddress,
    data: walletData,
    isPending: loading,
    isIdle,
    error,
  } = trpc.nowPayments.createDepositAddress.useMutation({
    onSuccess: () => {
      utils.nowPayments.getDepositHistory.invalidate();
    },
  });

  const [autoChecked, setAutoChecked] = useState(false);
  React.useEffect(() => {
    if (!autoChecked) {
      setAutoChecked(true);
      createOrGetAddress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const depositAddress = walletData?.address ?? '';

  return (
    <DepositCardVariantC
      depositAddress={depositAddress}
      error={error}
      loading={loading || isIdle}
      onRetry={createOrGetAddress}
    />
  );
}
