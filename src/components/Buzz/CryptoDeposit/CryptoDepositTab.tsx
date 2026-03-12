import { Alert, Stack, Text } from '@mantine/core';
import { useCallback, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DepositAddressCard } from '~/components/Buzz/CryptoDeposit/DepositAddressCard';
import { OnrampGuidance, OnrampGuidanceToggle } from '~/components/Buzz/CryptoDeposit/OnrampGuidance';
import { DepositHistory } from '~/components/Buzz/CryptoDeposit/DepositHistory';
import type { GetDepositAddressInput } from '~/server/schema/nowpayments.schema';

export function CryptoDepositTab() {
  const currentUser = useCurrentUser();
  const [selectedChain, setSelectedChain] = useState<GetDepositAddressInput['chain']>('evm');

  const handleCurrencySelect = useCallback((_code: string, chain: string) => {
    setSelectedChain(chain as GetDepositAddressInput['chain']);
  }, []);

  if (!currentUser) {
    return (
      <Alert color="yellow" title="Sign in required">
        <Text>You must be signed in to use crypto deposits.</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="lg" mt="md">
      <DepositAddressCard chain={selectedChain} onCurrencySelect={handleCurrencySelect} />
      <OnrampGuidance />
      <DepositHistory />
      <OnrampGuidanceToggle />
    </Stack>
  );
}
