import { NotFound } from '~/components/AppLayout/NotFound';
import {
  useTipaltiConfigurationUrl,
  useUserPaymentConfiguration,
} from '~/components/UserPaymentConfiguration/util';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useRef, useState } from 'react';
import { Container, Stack, Title, Text, SegmentedControl, Center, Loader } from '@mantine/core';

export default function Onboard() {
  const { userPaymentConfiguration, isLoading: isLoadingUserPaymentConfiguration } =
    useUserPaymentConfiguration();

  const [type, setType] = useState<'setup' | 'paymentHistory'>('setup');
  const { tipaltiConfigurationUrl, isLoading: isLoadingTipaltiConfigurationUrl } =
    useTipaltiConfigurationUrl({ type }, !!userPaymentConfiguration?.tipaltiAccountId);

  if (isLoadingUserPaymentConfiguration) {
    return <PageLoader />;
  }

  if (!userPaymentConfiguration?.tipaltiAccountId) {
    return <NotFound />;
  }

  return (
    <Container>
      <Stack>
        <Title order={3}>Setup your Tipalti Account</Title>
        <Text size="sm" color="faded">
          Below iFrame has been directly provided by Tipalti to ensure your account is setup
          correctly and your data is safe. Please follow the instructions provided by Tipalti to
          complete, update and modify your account. This is required to receive payments.
        </Text>
        <SegmentedControl
          value={type}
          onChange={(v: 'setup' | 'paymentHistory') => setType(v)}
          data={[
            { label: 'Onboarding / Setup', value: 'setup' },
            { label: 'Payment History', value: 'paymentHistory' },
          ]}
          mt="md"
          mb="md"
        />
        {isLoadingTipaltiConfigurationUrl ? (
          <Center>
            <Loader />
          </Center>
        ) : (
          <iframe
            src={tipaltiConfigurationUrl}
            style={{
              width: '100%',
              height: '100%',
              minHeight: 'calc(100vh - 200px)',
            }}
            key={type}
          />
        )}
      </Stack>
    </Container>
  );
}
