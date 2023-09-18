import { Text, Card, Title, Stack, Button } from '@mantine/core';

import { trpc } from '~/utils/trpc';

export function UserReferralCodesCard() {
  const { data: userReferralCodes = [] } = trpc.userReferralCode.getAll.useQuery({});

  return (
    <Card withBorder>
      <Stack>
        <Stack spacing={0}>
          <Title order={2}>Referral Codes</Title>
          <Text color="dimmed" size="sm">
            You can use referral codes to invite your friends to join the platform. Referring
            accounts will grant you 500 Buzz which you can use to generate content, run bounties and
            more!
          </Text>
        </Stack>
        <Stack>
          {userReferralCodes.length === 0 ? (
            <Text color="red">Looks like you have created no referral codes just yet.</Text>
          ) : (
            <Text>You have created {userReferralCodes.length} referral code</Text>
          )}
          <Button onClick={() => console.log('generando')}>Generate new referral code</Button>
        </Stack>
      </Stack>
    </Card>
  );
}
