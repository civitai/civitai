import { Alert, Stack, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DepositAddressCard } from '~/components/Buzz/CryptoDeposit/DepositAddressCard';
import { OnrampGuidance, OnrampGuidanceToggle } from '~/components/Buzz/CryptoDeposit/OnrampGuidance';
import { DepositHistory } from '~/components/Buzz/CryptoDeposit/DepositHistory';

export function CryptoDepositTab() {
  const currentUser = useCurrentUser();

  if (!currentUser) {
    return (
      <Alert color="yellow" title="Sign in required">
        <Text>You must be signed in to use crypto deposits.</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="lg" mt="md">
      <DepositAddressCard />
      <OnrampGuidance />
      <DepositHistory />
      <OnrampGuidanceToggle />
    </Stack>
  );
}
