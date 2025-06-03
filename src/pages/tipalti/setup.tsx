import { NotFound } from '~/components/AppLayout/NotFound';
import {
  useTipaltiConfigurationUrl,
  useUserPaymentConfiguration,
} from '~/components/UserPaymentConfiguration/util';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useState } from 'react';
import { Container, Stack, Title, Text, SegmentedControl, Center, Loader } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';

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
    <>
      <Meta deIndex />
      <Container>
        <Stack>
          <Title order={3}>Set up your Tipalti Account</Title>
          <Text size="sm" color="faded">
            The iFrame below is provided by Tipalti to ensure secure setup and account accuracy.
            Please follow Tipalti&rsquo;s instructions to complete or update your account, to be
            eligible to receive payments.
          </Text>
          <SegmentedControl
            value={type}
            onChange={(v) => setType(v as 'setup' | 'paymentHistory')}
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
    </>
  );
}
