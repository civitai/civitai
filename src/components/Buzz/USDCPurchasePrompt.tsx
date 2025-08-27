import { Button, Group, Text, Loader } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useState, useEffect } from 'react';
import { useCoinbaseOnrampBalance, useMutateCoinbase } from '~/components/Coinbase/util';
import { usdcToBuzz } from '~/utils/buzz';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

interface USDCPurchasePromptProps {
  userId?: number;
}

export const USDCPurchasePrompt = ({ userId }: USDCPurchasePromptProps) => {
  const currentUserId = userId;
  const [shouldShow, setShouldShow] = useState(false);

  // First check if user has pending transactions in database
  const { data: transactions, isLoading: isLoadingTransactions } =
    trpc.coinbase.getPaginatedUserTransactions.useQuery(
      {
        limit: 1,
        page: 1,
      },
      {
        enabled: !!currentUserId,
      }
    );

  // Only check wallet balance if we found pending transactions
  const { data: balanceData, isLoading: isLoadingBalance } = useCoinbaseOnrampBalance();
  const { processUserPendingTransactions, processingUserPendingTransactions } = useMutateCoinbase();

  const balance = balanceData?.balance ?? 0;
  const buzzAmount = usdcToBuzz(balance);

  useEffect(() => {
    // Check if user has any crypto transactions that indicate they might have USDC
    if (transactions?.items?.length) {
      const hasPendingOrSuccess = transactions.items.some(
        (t) =>
          t.status === CryptoTransactionStatus.RampSuccess ||
          t.status === CryptoTransactionStatus.WaitingForRamp ||
          t.status === CryptoTransactionStatus.WaitingForSweep
      );
      setShouldShow(hasPendingOrSuccess && balance > 0);
    } else {
      setShouldShow(false);
    }
  }, [transactions, balance]);

  const handlePurchase = async () => {
    if (processingUserPendingTransactions || isLoadingBalance || balance <= 0) {
      return;
    }

    try {
      await processUserPendingTransactions();
    } catch (error) {
      console.error('Error processing pending transactions:', error);
    }
  };

  // Don't render anything during initial load or if conditions aren't met
  if (!shouldShow || isLoadingTransactions) {
    return null;
  }

  if (isLoadingBalance) {
    return (
      <Group
        gap="sm"
        p="md"
        style={{
          backgroundColor: 'var(--mantine-color-teal-1)',
          borderRadius: 'var(--mantine-radius-md)',
          border: '2px solid var(--mantine-color-teal-4)',
        }}
      >
        <Loader size="sm" />
        <Text size="sm" c="teal.8">
          Checking USDC balance...
        </Text>
      </Group>
    );
  }

  return (
    <Group
      justify="space-between"
      wrap="wrap"
      p="md"
      gap="md"
      style={{
        backgroundColor: 'var(--mantine-color-teal-1)',
        borderRadius: 'var(--mantine-radius-md)',
        border: '2px solid var(--mantine-color-teal-4)',
      }}
    >
      <Text size="sm" fw={600} c="teal.8">
        💰 You have ${balance.toFixed(2)} USDC available
      </Text>
      <Button
        loading={processingUserPendingTransactions}
        onClick={handlePurchase}
        color="teal"
        size="sm"
        fw={500}
        leftSection={<IconBolt size={16} fill="currentColor" />}
      >
        Purchase {numberWithCommas(buzzAmount)} Buzz
      </Button>
    </Group>
  );
};
