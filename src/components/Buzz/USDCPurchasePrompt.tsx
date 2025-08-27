import { Button, Card, Group, Stack, Text, Loader, ThemeIcon, Badge, Center } from '@mantine/core';
import { IconBolt, IconWallet, IconArrowRight, IconCurrencyDollar } from '@tabler/icons-react';
import { useState, useEffect } from 'react';
import { useCoinbaseOnrampBalance, useMutateCoinbase } from '~/components/Coinbase/util';
import { usdcToBuzz } from '~/utils/buzz';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';
import classes from './USDCPurchasePrompt.module.scss';

interface USDCPurchasePromptProps {
  userId?: number;
}

// Hook to check if USDC prompt should show (for other components to use)
export const useUSDCPurchasePromptVisibility = (userId?: number) => {
  const [shouldShow, setShouldShow] = useState(false);
  
  const { data: transactions, isLoading: isLoadingTransactions } =
    trpc.coinbase.getPaginatedUserTransactions.useQuery(
      {
        limit: 1,
        page: 1,
      },
      {
        enabled: !!userId,
      }
    );

  const { data: balanceData, isLoading: isLoadingBalance } = useCoinbaseOnrampBalance();
  const balance = balanceData?.balance ?? 0;

  useEffect(() => {
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

  return {
    shouldShow: shouldShow && !isLoadingTransactions,
    isLoading: isLoadingTransactions || isLoadingBalance,
  };
};

export const USDCPurchasePrompt = ({ userId }: USDCPurchasePromptProps) => {
  const { shouldShow, isLoading } = useUSDCPurchasePromptVisibility(userId);
  const { data: balanceData, isLoading: isLoadingBalance } = useCoinbaseOnrampBalance();
  const { processUserPendingTransactions, processingUserPendingTransactions } = useMutateCoinbase();

  const balance = balanceData?.balance ?? 0;
  const buzzAmount = usdcToBuzz(balance);

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
  if (!shouldShow || isLoading) {
    return null;
  }

  if (isLoadingBalance) {
    return (
      <Card className={classes.loadingCard} padding="md" radius="md" withBorder>
        <Group gap="sm" justify="center">
          <Loader size="sm" color="teal" />
          <Text size="sm" c="teal.8" fw={500}>
            Checking USDC balance...
          </Text>
        </Group>
      </Card>
    );
  }

  return (
    <Card
      className={classes.usdcCard}
      padding="md"
      radius="md"
      withBorder
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon
            size="lg"
            variant="gradient"
            gradient={{ from: 'teal.4', to: 'green.5' }}
            radius="md"
            className={classes.usdcIcon}
          >
            <IconWallet size={24} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            <Text size="sm" fw={600} className={classes.usdcTitle}>
              ${balance.toFixed(2)} USDC Available
            </Text>
            <Text size="xs" c="dimmed">
              Purchase {numberWithCommas(buzzAmount)} Buzz instantly
            </Text>
          </div>
        </Group>
        <Button
          loading={processingUserPendingTransactions}
          onClick={handlePurchase}
          variant="gradient"
          gradient={{ from: 'teal.4', to: 'green.5' }}
          size="sm"
          leftSection={<IconBolt size={16} fill="currentColor" />}
          radius="md"
        >
          Purchase Buzz
        </Button>
      </Group>
    </Card>
  );
};
