import { Button, Card, Group, Text, Loader, ThemeIcon } from '@mantine/core';
import { IconBolt, IconWallet } from '@tabler/icons-react';
import { usdcToBuzz } from '~/utils/buzz';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

interface USDCPurchasePromptProps {
  userId?: number;
}

// Hook to check if USDC prompt should show (for other components to use)
export const useUSDCPurchasePromptVisibility = (userId?: number) => {
  const { data, isLoading } = trpc.zkp2p.checkUSDCAvailability.useQuery(
    undefined,
    {
      enabled: !!userId,
      refetchOnWindowFocus: false,
    }
  );

  return {
    shouldShow: data?.shouldShow ?? false,
    balance: data?.balance ?? 0,
    isLoading,
  };
};

export const USDCPurchasePrompt = ({ userId }: USDCPurchasePromptProps) => {
  const { shouldShow, balance, isLoading } = useUSDCPurchasePromptVisibility(userId);
  const processUSDCPurchase = trpc.zkp2p.processUSDCPurchase.useMutation();
  const utils = trpc.useUtils();

  const buzzAmount = usdcToBuzz(balance);

  const handlePurchase = async () => {
    if (processUSDCPurchase.isLoading || balance <= 0 || !userId) {
      return;
    }

    try {
      await processUSDCPurchase.mutateAsync({ amount: balance });
      // Refetch the availability data to update the UI
      await utils.zkp2p.checkUSDCAvailability.invalidate();
      // Could also trigger a refetch of user's buzz balance here
    } catch (error) {
      console.error('Error processing USDC purchase:', error);
      // Error handling could be improved with notifications
    }
  };

  // Don't render anything during initial load or if conditions aren't met
  if (!shouldShow || isLoading) {
    return null;
  }

  if (isLoading) {
    return (
      <Card padding="md" radius="md" withBorder>
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
    <Card padding="md" radius="md" withBorder>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon
            size="lg"
            variant="gradient"
            gradient={{ from: 'teal.4', to: 'green.5' }}
            radius="md"
          >
            <IconWallet size={24} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            <Text size="sm" fw={600}>
              ${balance.toFixed(2)} USDC Available
            </Text>
            <Text size="xs" c="dimmed">
              Purchase {numberWithCommas(buzzAmount)} Buzz instantly
            </Text>
          </div>
        </Group>
        <Button
          loading={processUSDCPurchase.isLoading}
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